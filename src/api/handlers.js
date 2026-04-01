import { json } from '../core/response.js';
import { requireAuth, signToken } from '../core/auth.js';
import { authorizeRoles } from '../core/rbac.js';
import { normalizeRole } from '../core/roles.js';
import { getDb } from '../db/index.js';
import { calculatePlan, startFreeTrial } from '../services/subscription.js';
import { canParticipate } from '../services/access.js';
import { VERIFICATION_STATUS, SUB_STATUS } from '../types/constants.js';
import { detectSoftOrder } from '../services/orders.js';

async function parse(req) { return req.json(); }

const SUPER_ADMIN_EMAIL = 'abdulkareem.t@gmail.com';
const OTP_WINDOW_MINUTES = 10;
const OTP_MAX_REQUESTS = 3;
const OTP_EXPIRY_MINUTES = 5;
const WHATSAPP_OTP_PURPOSE_TEXT = 'Hi VYNTARO verify my number';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateSixDigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim();
}

async function sendWhatsAppMessage(phone, message, env) {
  if (env.WHATSAPP_API_URL && env.WHATSAPP_API_TOKEN) {
    const res = await fetch(env.WHATSAPP_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: phone,
        type: 'text',
        text: { body: message }
      })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`whatsapp api error: ${res.status} ${body}`);
    }
    return;
  }

  if (env.WHATSAPP_WEBHOOK_ECHO_URL) {
    await fetch(env.WHATSAPP_WEBHOOK_ECHO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, message })
    });
  }
}

export async function sendEmailOTP(email, otp, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'PulseLane <no-reply@aureliv.in>',
      to: email,
      subject: 'Your VyntaroChat Admin OTP',
      html: `<h2>Your OTP is: ${otp}</h2><p>Valid for 5 minutes</p>`
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resend error: ${res.status} ${text}`);
  }
}

function generateAdminToken(email, env) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (7 * 24 * 60 * 60);
  return signToken({ email, role: 'superadmin', iat: now, exp }, env.JWT_SECRET);
}

async function requireSuperAdmin(req, env) {
  const auth = await requireAuth(req, env);
  if (!auth) return { error: json({ error: 'unauthorized' }, 401) };
  if (auth.exp && Math.floor(Date.now() / 1000) > Number(auth.exp)) {
    return { error: json({ error: 'token expired' }, 401) };
  }
  if (auth.role !== 'superadmin' || normalizeEmail(auth.email) !== SUPER_ADMIN_EMAIL) {
    return { error: json({ error: 'forbidden' }, 403) };
  }
  return { auth };
}

export async function adminSendOtp(req, env) {
  const sql = getDb(env);
  const { email } = await parse(req);
  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail !== SUPER_ADMIN_EMAIL) return json({ error: 'invalid admin email' }, 403);
  if (!env.RESEND_API_KEY) return json({ error: 'resend not configured' }, 500);

  const [rate] = await sql`
    SELECT COUNT(*)::int AS count
    FROM admin_otps
    WHERE email = ${normalizedEmail}
      AND created_at >= NOW() - (${OTP_WINDOW_MINUTES} * INTERVAL '1 minute')
  `;

  if (rate.count >= OTP_MAX_REQUESTS) {
    return json({ error: 'too many otp requests, try again later' }, 429);
  }

  const otp = generateSixDigitOtp();
  await sql`
    INSERT INTO admin_otps (email, otp, expires_at, used)
    VALUES (${normalizedEmail}, ${otp}, NOW() + (${OTP_EXPIRY_MINUTES} * INTERVAL '1 minute'), false)
  `;

  await sendEmailOTP(normalizedEmail, otp, env);
  return json({ ok: true, message: 'otp sent' });
}

export async function adminVerifyOtp(req, env) {
  const sql = getDb(env);
  const { email, otp } = await parse(req);
  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail !== SUPER_ADMIN_EMAIL) return json({ error: 'invalid admin email' }, 403);
  if (!/^\d{6}$/.test(String(otp || ''))) return json({ error: 'invalid otp format' }, 400);

  const [row] = await sql`
    SELECT id, email, otp, expires_at, used
    FROM admin_otps
    WHERE email = ${normalizedEmail}
      AND otp = ${String(otp)}
      AND used = false
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!row) return json({ error: 'otp invalid' }, 401);
  if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: 'otp expired' }, 401);

  await sql`UPDATE admin_otps SET used = true WHERE id = ${row.id}`;
  const token = await generateAdminToken(normalizedEmail, env);
  return json({ token, role: 'superadmin', email: normalizedEmail });
}

export async function adminUsers(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;

  const users = await sql`SELECT id, name, phone, role, is_verified, verification_status, created_at FROM users ORDER BY created_at DESC LIMIT 200`;
  return json({ items: users });
}

export async function adminChats(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;

  const chats = await sql`SELECT id, user_a, user_b, created_at, updated_at FROM chats ORDER BY updated_at DESC LIMIT 200`;
  return json({ items: chats });
}

export async function adminSubscriptions(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;

  const subscriptions = await sql`
    SELECT id, user_id, role, plan_type, total_amount, start_date, end_date, status, verified, created_at
    FROM subscriptions
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return json({ items: subscriptions });
}

export async function adminAnalytics(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;

  const [stats] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM users) AS users,
      (SELECT COUNT(*)::int FROM chats) AS chats,
      (SELECT COUNT(*)::int FROM messages) AS messages,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status = 'active') AS active_subscriptions
  `;
  return json({ analytics: stats });
}

export async function login(req, env) {
  const sql = getDb(env);
  const { phone, role, otp } = await parse(req);
  const normalizedRole = normalizeRole(role);
  if (!phone || !normalizedRole || (!otp && normalizedRole === 'STUDENT')) return json({ error: 'invalid payload' }, 400);
  if (normalizedRole === 'STUDENT' && otp !== env.OTP_TEST_BYPASS) return json({ error: 'otp invalid' }, 401);

  let [user] = await sql`SELECT * FROM users WHERE phone = ${phone}`;
  if (!user) {
    [user] = await sql`
      INSERT INTO users (phone, role, is_verified, verification_status)
      VALUES (${phone}, ${normalizedRole}, ${normalizedRole === 'STUDENT'}, ${normalizedRole === 'STUDENT' ? VERIFICATION_STATUS.APPROVED : VERIFICATION_STATUS.PENDING})
      RETURNING *
    `;
    await startFreeTrial(sql, user.id, normalizedRole);
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

export async function onboardingStatus(req, env) {
  const sql = getDb(env);
  const url = new URL(req.url);
  const phone = normalizePhone(url.searchParams.get('phone'));
  const deviceId = String(url.searchParams.get('device_id') || '').trim();
  if (!phone || !deviceId) return json({ error: 'phone and device_id required' }, 400);

  const [user] = await sql`
    SELECT id, phone, device_id, role, is_verified, is_approved, verification_status, location_lat, location_lng
    FROM users
    WHERE phone = ${phone} AND device_id = ${deviceId}
    LIMIT 1
  `;
  if (!user) {
    return json({
      is_first_time: true,
      next_step: 'verify_phone',
      verify_prompt: 'Verify your number to continue'
    });
  }

  return json({
    is_first_time: false,
    user,
    next_step: user.is_verified && user.is_approved ? 'chat' : 'awaiting_approval'
  });
}

export async function onboardingRequestOtp(req, env) {
  const sql = getDb(env);
  const { phone } = await parse(req);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return json({ error: 'phone required' }, 400);

  const [rate] = await sql`
    SELECT COUNT(*)::int AS count
    FROM otp_codes
    WHERE phone = ${normalizedPhone}
      AND created_at >= NOW() - (${OTP_WINDOW_MINUTES} * INTERVAL '1 minute')
  `;
  if (rate.count >= OTP_MAX_REQUESTS) return json({ error: 'too many otp requests' }, 429);

  const otp = generateSixDigitOtp();
  await sql`
    INSERT INTO otp_codes (phone, otp, expires_at, verified)
    VALUES (${normalizedPhone}, ${otp}, NOW() + (${OTP_EXPIRY_MINUTES} * INTERVAL '1 minute'), false)
  `;

  await sendWhatsAppMessage(normalizedPhone, `${WHATSAPP_OTP_PURPOSE_TEXT}\nYour OTP is ${otp}. It expires in 5 minutes.`, env);
  return json({ ok: true, message: 'otp sent via whatsapp' });
}

export async function onboardingVerifyOtp(req, env) {
  const sql = getDb(env);
  const { phone, otp, device_id } = await parse(req);
  const normalizedPhone = normalizePhone(phone);
  const deviceId = String(device_id || '').trim();
  if (!normalizedPhone || !/^\d{6}$/.test(String(otp || '')) || !deviceId) {
    return json({ error: 'invalid payload' }, 400);
  }

  const [row] = await sql`
    SELECT id, phone, otp, expires_at, verified
    FROM otp_codes
    WHERE phone = ${normalizedPhone}
      AND otp = ${String(otp)}
      AND verified = false
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!row) return json({ error: 'otp invalid' }, 401);
  if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: 'otp expired' }, 401);

  await sql`UPDATE otp_codes SET verified = true WHERE id = ${row.id}`;

  let [user] = await sql`SELECT * FROM users WHERE phone = ${normalizedPhone} LIMIT 1`;
  if (!user) {
    [user] = await sql`
      INSERT INTO users (phone, device_id, role, is_verified, verification_status, is_approved)
      VALUES (${normalizedPhone}, ${deviceId}, 'STUDENT', true, ${VERIFICATION_STATUS.PENDING}, false)
      RETURNING *
    `;
  } else {
    [user] = await sql`
      UPDATE users
      SET device_id = ${deviceId}, is_verified = true
      WHERE id = ${user.id}
      RETURNING *
    `;
  }

  const token = await signToken({ sub: user.id, role: user.role }, env.JWT_SECRET);
  return json({ ok: true, token, user, next_step: 'role_selection' });
}

export async function onboardingRole(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { role } = await parse(req);
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return json({ error: 'invalid role' }, 400);

  const [user] = await sql`
    UPDATE users
    SET role = ${normalizedRole}
    WHERE id = ${auth.sub}
    RETURNING *
  `;
  return json({ user, next_step: 'location' });
}

export async function onboardingLocation(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { lat, lng, available } = await parse(req);
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return json({ error: 'invalid location' }, 400);

  const [user] = await sql`
    UPDATE users
    SET latitude = ${Number(lat)},
        longitude = ${Number(lng)},
        location_lat = ${Number(lat)},
        location_lng = ${Number(lng)},
        discoverable = ${available !== false}
    WHERE id = ${auth.sub}
    RETURNING id, role, location_lat, location_lng, discoverable
  `;
  return json({ user, next_step: 'consent' });
}

export async function onboardingConsent(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { accepted_terms } = await parse(req);
  if (!accepted_terms) return json({ error: 'terms consent is mandatory' }, 400);

  await sql`
    INSERT INTO consents (user_id, accepted_terms, timestamp)
    VALUES (${auth.sub}, true, NOW())
  `;
  return json({ ok: true, next_step: 'subscription' });
}

export async function onboardingSubscription(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const { action, plan_type, payment_reference, payment_proof_url } = await parse(req);
  const [user] = await sql`SELECT id, role FROM users WHERE id = ${auth.sub}`;
  if (!user) return json({ error: 'user not found' }, 404);

  if (user.role === 'STUDENT') {
    await sql`UPDATE users SET is_approved = true, verification_status = ${VERIFICATION_STATUS.APPROVED} WHERE id = ${auth.sub}`;
    return json({ ok: true, status: 'active', next_step: 'chat' });
  }

  const selectedPlan = plan_type === 'yearly' ? 'yearly' : 'monthly';
  const { amount, gst, totalAmount } = calculatePlan(user.role, selectedPlan);
  const now = new Date();
  const oneMonth = new Date(now);
  oneMonth.setMonth(oneMonth.getMonth() + 1);
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + (selectedPlan === 'yearly' ? 12 : 1));

  if (action === 'trial') {
    await sql`
      INSERT INTO subscriptions (user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, trial_start, trial_end, status, verified)
      VALUES (${auth.sub}, ${user.role}, ${selectedPlan}, 0, 0, 0, ${now.toISOString()}, ${oneMonth.toISOString()}, ${now.toISOString()}, ${oneMonth.toISOString()}, ${SUB_STATUS.ACTIVE}, true)
    `;
    return json({ ok: true, status: 'trial_active', trial_start: now, trial_end: oneMonth, next_step: 'chat' });
  }

  await sql`
    INSERT INTO subscriptions (user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, payment_proof_url, payment_reference, verified)
    VALUES (${auth.sub}, ${user.role}, ${selectedPlan}, ${amount}, ${gst}, ${totalAmount}, ${now.toISOString()}, ${endDate.toISOString()}, ${SUB_STATUS.PENDING}, ${payment_proof_url || null}, ${payment_reference || null}, false)
  `;
  return json({ ok: true, status: 'pending', next_step: 'admin_approval' });
}

export async function adminApproveOnboarding(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;
  const { user_id, approved } = await parse(req);

  await sql`
    UPDATE users
    SET is_approved = ${!!approved},
        verification_status = ${approved ? VERIFICATION_STATUS.APPROVED : VERIFICATION_STATUS.REJECTED}
    WHERE id = ${user_id}
  `;
  return json({ ok: true });
}

export async function subscriptionUpload(req, env) {
  const sql = getDb(env);
  const auth = await requireAuth(req, env);
  if (!auth) return json({ error: 'unauthorized' }, 401);
  const authRole = normalizeRole(auth.role);
  if (!authRole) return json({ error: 'invalid role' }, 403);
  const { plan_type, payment_reference, payment_proof_url } = await parse(req);
  const { amount, gst, totalAmount } = calculatePlan(authRole, plan_type);

  const start = new Date();
  const end = new Date(start);
  end.setMonth(end.getMonth() + (plan_type === 'yearly' ? 12 : 1));

  const [row] = await sql`
    INSERT INTO subscriptions (user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, payment_proof_url, payment_reference, verified)
    VALUES (${auth.sub}, ${authRole}, ${plan_type}, ${amount}, ${gst}, ${totalAmount}, ${start.toISOString()}, ${end.toISOString()}, ${SUB_STATUS.PENDING}, ${payment_proof_url}, ${payment_reference}, false)
    RETURNING *
  `;
  return json({ subscription: row });
}

export async function subscriptionVerify(req, env) {
  const sql = getDb(env);
  const adminGuard = authorizeRoles('ADMIN', 'SUPER_ADMIN');
  const guardResult = await adminGuard(req, env);
  if (guardResult.error) return guardResult.error;

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
    WHERE role = 'IPO' AND is_verified = true AND verification_status = 'approved' AND discoverable = true
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
    WHERE role = 'COLLEGE_COORDINATOR' AND is_verified = true AND verification_status = 'approved' AND discoverable = true
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

  const normalizedContent = message_type === 'file'
    ? {
      fileId: content?.fileId,
      fileName: typeof content?.fileName === 'string' ? content.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) : 'file',
      fileType: content?.fileType,
      size: content?.size || null
    }
    : content;

  const [msg] = await sql`
    INSERT INTO messages (chat_id, sender_id, message_type, content)
    VALUES (${chat_id}, ${auth.sub}, ${message_type}, ${JSON.stringify(normalizedContent)})
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
