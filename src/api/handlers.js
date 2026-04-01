import { json } from '../core/response.js';
import { requireAuth, signToken } from '../core/auth.js';
import { getDb } from '../db/index.js';
import { calculatePlan, startFreeTrial } from '../services/subscription.js';
import { canParticipate } from '../services/access.js';
import { VERIFICATION_STATUS, SUB_STATUS } from '../types/constants.js';
import { detectSoftOrder } from '../services/orders.js';

async function parse(req) { return req.json(); }

export async function login(req, env) {
  const sql = getDb(env);
  const { phone, role, otp } = await parse(req);
  if (!phone || !role || (!otp && role === 'customer')) return json({ error: 'invalid payload' }, 400);
  if (role === 'customer' && otp !== env.OTP_TEST_BYPASS) return json({ error: 'otp invalid' }, 401);

  let [user] = await sql`SELECT * FROM users WHERE phone = ${phone}`;
  if (!user) {
    [user] = await sql`
      INSERT INTO users (phone, role, is_verified, verification_status)
      VALUES (${phone}, ${role}, ${role === 'customer'}, ${role === 'customer' ? VERIFICATION_STATUS.APPROVED : VERIFICATION_STATUS.PENDING})
      RETURNING *
    `;
    await startFreeTrial(sql, user.id, role);
  }
  const token = await signToken({ sub: user.id, role: user.role }, env.JWT_SECRET);
  return json({ token, user });
}

export async function onboardingVerify(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { documents } = await parse(req);

  await sql`
    UPDATE users
    SET documents = ${JSON.stringify(documents || {})}, verification_status = ${VERIFICATION_STATUS.PENDING}
    WHERE id = ${auth.sub}
  `;
  await sql`
    INSERT INTO verification_documents (user_id, documents, status)
    VALUES (${auth.sub}, ${JSON.stringify(documents || {})}, ${VERIFICATION_STATUS.PENDING})
  `;
  return json({ status: 'submitted' });
}

export async function subscriptionUpload(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { plan_type, payment_reference, payment_proof_url } = await parse(req);
  const { amount, gst, totalAmount } = calculatePlan(auth.role, plan_type);

  const start = new Date();
  const end = new Date(start);
  end.setMonth(end.getMonth() + (plan_type === 'yearly' ? 12 : 1));

  const [row] = await sql`
    INSERT INTO subscriptions (user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, payment_proof_url, payment_reference, verified)
    VALUES (${auth.sub}, ${auth.role}, ${plan_type}, ${amount}, ${gst}, ${totalAmount}, ${start.toISOString()}, ${end.toISOString()}, ${SUB_STATUS.PENDING}, ${payment_proof_url}, ${payment_reference}, false)
    RETURNING *
  `;
  return json({ subscription: row });
}

export async function subscriptionVerify(req, env) {
  const sql = getDb(env);
  const { subscription_id, approved } = await parse(req);
  await sql`
    UPDATE subscriptions
    SET verified = ${!!approved}, status = ${approved ? SUB_STATUS.ACTIVE : SUB_STATUS.PENDING}
    WHERE id = ${subscription_id}
  `;
  return json({ ok: true });
}

export async function subscriptionStatus(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);

  const [row] = await sql`
    SELECT * FROM subscriptions WHERE user_id = ${auth.sub}
    ORDER BY end_date DESC LIMIT 1
  `;
  return json({ subscription: row || null });
}

export async function nearbyDrivers(req, env) {
  const sql = getDb(env);
  const lat = Number(new URL(req.url).searchParams.get('lat'));
  const lng = Number(new URL(req.url).searchParams.get('lng'));
  const rows = await sql`
    SELECT id, name, role, latitude, longitude
    FROM users
    WHERE role = 'driver' AND is_verified = true AND verification_status = 'approved' AND discoverable = true
    ORDER BY ((latitude - ${lat})^2 + (longitude - ${lng})^2) ASC
    LIMIT 25
  `;
  return json({ items: rows });
}

export async function nearbyShops(req, env) {
  const sql = getDb(env);
  const lat = Number(new URL(req.url).searchParams.get('lat'));
  const lng = Number(new URL(req.url).searchParams.get('lng'));
  const rows = await sql`
    SELECT id, name, role, latitude, longitude
    FROM users
    WHERE role = 'shop_owner' AND is_verified = true AND verification_status = 'approved' AND discoverable = true
    ORDER BY ((latitude - ${lat})^2 + (longitude - ${lng})^2) ASC
    LIMIT 25
  `;
  return json({ items: rows });
}

export async function chatStart(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { peer_id } = await parse(req);

  if (!(await canParticipate(sql, auth.sub)) || !(await canParticipate(sql, peer_id))) {
    return json({ error: 'inactive account' }, 403);
  }

  const [chat] = await sql`
    INSERT INTO chats (user_a, user_b)
    VALUES (${auth.sub}, ${peer_id})
    ON CONFLICT (user_a, user_b) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;
  return json({ chat });
}

export async function chatMessage(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { chat_id, message_type, content } = await parse(req);

  const [msg] = await sql`
    INSERT INTO messages (chat_id, sender_id, message_type, content)
    VALUES (${chat_id}, ${auth.sub}, ${message_type}, ${JSON.stringify(content)})
    RETURNING *
  `;

  const softOrder = message_type === 'text' ? detectSoftOrder(content?.text || '') : null;
  if (softOrder) {
    await sql`
      INSERT INTO orders (chat_id, user_id, order_payload, source, confidence)
      VALUES (${chat_id}, ${auth.sub}, ${JSON.stringify(softOrder)}, 'nlp_soft_capture', ${softOrder.confidence})
    `;
  }
  return json({ message: msg, soft_order: softOrder });
}

export async function analyticsById(req, env, userId) {
  const sql = getDb(env);
  const [summary] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'order') AS orders,
      COUNT(*) FILTER (WHERE event_type = 'chat_message') AS messages,
      COALESCE(MAX(payload->>'top_item'), 'N/A') as top_item,
      COALESCE(MAX(payload->>'peak_time'), 'N/A') as peak_time
    FROM analytics_events
    WHERE user_id = ${userId} AND created_at::date = NOW()::date
  `;
  return json({ user_id: userId, today: summary });
}
