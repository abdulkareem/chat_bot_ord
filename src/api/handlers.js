import { json } from '../core/response.js';
import { requireAuth, signToken } from '../core/auth.js';
import { authorizeRoles } from '../core/rbac.js';
import { isAppUserRole, normalizeRole } from '../core/roles.js';
import { getDb } from '../db/index.js';
import { APP_ID, SUB_STATUS, VERIFICATION_STATUS } from '../types/constants.js';
import { calculatePlan } from '../services/subscription.js';
import { canParticipate } from '../services/access.js';
import { detectSoftOrder } from '../services/orders.js';

async function parse(req) { return req.json(); }

const SUPER_ADMIN_EMAIL = 'abdulkareem.t@gmail.com';
const OTP_WINDOW_MINUTES = 10;
const OTP_MAX_REQUESTS = 3;
const OTP_EXPIRY_MINUTES = 5;

function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function normalizePhone(phone) { return String(phone || '').replace(/[^\d+]/g, '').trim(); }
function generateSixDigitOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

function enforceApp(req, channel = 'pwa') {
  const appId = req.headers.get('x-app-id');
  const clientChannel = req.headers.get('x-client-channel');
  if (appId !== APP_ID) return { error: json({ error: 'invalid app_id' }, 403) };
  if (channel && clientChannel !== channel) return { error: json({ error: `only ${channel} access allowed` }, 403) };
  return {};
}

async function requireSuperAdmin(req, env) {
  const scope = enforceApp(req, 'web');
  if (scope.error) return scope;
  const auth = await requireAuth(req, env);
  if (!auth) return { error: json({ error: 'unauthorized' }, 401) };
  if (auth.role !== 'SUPER_ADMIN' || normalizeEmail(auth.email) !== SUPER_ADMIN_EMAIL || auth.app_id !== APP_ID) {
    return { error: json({ error: 'forbidden' }, 403) };
  }
  return { auth };
}

export async function adminSendOtp(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'web'); if (scope.error) return scope.error;
  const { email } = await parse(req);
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== SUPER_ADMIN_EMAIL) return json({ error: 'invalid admin email' }, 403);
  const otp = generateSixDigitOtp();
  await sql`INSERT INTO admin_otps (app_id, email, otp, expires_at, used) VALUES (${APP_ID}, ${normalizedEmail}, ${otp}, NOW() + (${OTP_EXPIRY_MINUTES} * INTERVAL '1 minute'), false)`;
  return json({ ok: true, otp });
}

export async function adminVerifyOtp(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'web'); if (scope.error) return scope.error;
  const { email, otp } = await parse(req);
  const normalizedEmail = normalizeEmail(email);
  const [row] = await sql`SELECT id, expires_at FROM admin_otps WHERE app_id = ${APP_ID} AND email = ${normalizedEmail} AND otp = ${String(otp)} AND used = false ORDER BY created_at DESC LIMIT 1`;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return json({ error: 'otp invalid/expired' }, 401);
  await sql`UPDATE admin_otps SET used = true WHERE id = ${row.id} AND app_id = ${APP_ID}`;
  const now = Math.floor(Date.now() / 1000);
  const token = signToken({ email: normalizedEmail, role: 'SUPER_ADMIN', app_id: APP_ID, iat: now, exp: now + 604800 }, env.JWT_SECRET);
  return json({ token });
}

export async function adminUsers(req, env) {
  const sql = getDb(env); const guard = await requireSuperAdmin(req, env); if (guard.error) return guard.error;
  const users = await sql`SELECT id, name, phone, role, active, is_verified, verification_status, created_at FROM users WHERE app_id = ${APP_ID} ORDER BY created_at DESC LIMIT 200`;
  return json({ items: users });
}
export async function adminChats(req, env) {
  const sql = getDb(env); const guard = await requireSuperAdmin(req, env); if (guard.error) return guard.error;
  const chats = await sql`SELECT id, user_a, user_b, created_at, updated_at FROM chats WHERE app_id = ${APP_ID} ORDER BY updated_at DESC LIMIT 200`;
  return json({ items: chats });
}
export async function adminSubscriptions(req, env) {
  const sql = getDb(env); const guard = await requireSuperAdmin(req, env); if (guard.error) return guard.error;
  const subscriptions = await sql`SELECT id, user_id, role, plan_type, total_amount, start_date, end_date, status, verified, created_at FROM subscriptions WHERE app_id = ${APP_ID} ORDER BY created_at DESC LIMIT 200`;
  return json({ items: subscriptions });
}
export async function adminAnalytics(req, env) {
  const sql = getDb(env); const guard = await requireSuperAdmin(req, env); if (guard.error) return guard.error;
  const [stats] = await sql`SELECT (SELECT COUNT(*)::int FROM users WHERE app_id = ${APP_ID}) AS users,(SELECT COUNT(*)::int FROM chats WHERE app_id = ${APP_ID}) AS chats,(SELECT COUNT(*)::int FROM messages WHERE app_id = ${APP_ID}) AS messages,(SELECT COUNT(*)::int FROM subscriptions WHERE app_id = ${APP_ID} AND status = 'active') AS active_subscriptions`;
  return json({ analytics: stats });
}

export async function login(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error;
  const { phone, role, otp } = await parse(req);
  const normalizedRole = normalizeRole(role);
  if (!phone || !normalizedRole || !isAppUserRole(normalizedRole)) return json({ error: 'invalid payload' }, 400);
  if (!otp || otp !== env.OTP_TEST_BYPASS) return json({ error: 'otp invalid' }, 401);
  let [user] = await sql`SELECT * FROM users WHERE app_id = ${APP_ID} AND phone = ${phone}`;
  if (!user) {
    [user] = await sql`INSERT INTO users (app_id, phone, role, is_verified, verification_status) VALUES (${APP_ID}, ${phone}, ${normalizedRole}, true, ${VERIFICATION_STATUS.APPROVED}) RETURNING *`;
  }
  const token = signToken({ sub: user.id, role: user.role, app_id: APP_ID }, env.JWT_SECRET);
  return json({ token, user });
}

export async function onboardingVerify(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const { documents } = await parse(req); await sql`UPDATE users SET documents = ${JSON.stringify(documents || {})}, verification_status = ${VERIFICATION_STATUS.PENDING} WHERE id = ${auth.sub} AND app_id = ${APP_ID}`; await sql`INSERT INTO verification_documents (app_id, user_id, documents, status) VALUES (${APP_ID}, ${auth.sub}, ${JSON.stringify(documents || {})}, ${VERIFICATION_STATUS.PENDING})`; return json({ status: 'submitted' }); }

export async function onboardingStatus(req, env) {
  const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error;
  const url = new URL(req.url);
  const phone = normalizePhone(url.searchParams.get('phone'));
  const deviceId = String(url.searchParams.get('device_id') || '').trim();
  const [user] = await sql`SELECT id, phone, device_id, role, active, is_verified, is_approved, verification_status, location_lat, location_lng FROM users WHERE app_id = ${APP_ID} AND phone = ${phone} AND device_id = ${deviceId} LIMIT 1`;
  if (!user) return json({ is_first_time: true, next_step: 'verify_phone' });
  return json({ is_first_time: false, user, next_step: user.is_verified && user.is_approved ? 'chat' : 'awaiting_approval' });
}

export async function onboardingRequestOtp(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const { phone } = await parse(req); const normalizedPhone = normalizePhone(phone); const [rate] = await sql`SELECT COUNT(*)::int AS count FROM otp_codes WHERE app_id = ${APP_ID} AND phone = ${normalizedPhone} AND created_at >= NOW() - (${OTP_WINDOW_MINUTES} * INTERVAL '1 minute')`; if (rate.count >= OTP_MAX_REQUESTS) return json({ error: 'too many otp requests' }, 429); const otp = generateSixDigitOtp(); await sql`INSERT INTO otp_codes (app_id, phone, otp, expires_at, verified) VALUES (${APP_ID}, ${normalizedPhone}, ${otp}, NOW() + (${OTP_EXPIRY_MINUTES} * INTERVAL '1 minute'), false)`; return json({ ok: true, otp }); }

export async function onboardingVerifyOtp(req, env) {
  const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error;
  const { phone, otp, device_id } = await parse(req);
  const normalizedPhone = normalizePhone(phone);
  const [row] = await sql`SELECT id, expires_at FROM otp_codes WHERE app_id = ${APP_ID} AND phone = ${normalizedPhone} AND otp = ${String(otp)} AND verified = false ORDER BY created_at DESC LIMIT 1`;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return json({ error: 'otp invalid' }, 401);
  await sql`UPDATE otp_codes SET verified = true WHERE id = ${row.id} AND app_id = ${APP_ID}`;
  let [user] = await sql`SELECT * FROM users WHERE app_id = ${APP_ID} AND phone = ${normalizedPhone} LIMIT 1`;
  if (!user) [user] = await sql`INSERT INTO users (app_id, phone, device_id, role, is_verified, verification_status, is_approved) VALUES (${APP_ID}, ${normalizedPhone}, ${device_id}, 'CUSTOMER', true, ${VERIFICATION_STATUS.PENDING}, false) RETURNING *`;
  else [user] = await sql`UPDATE users SET device_id = ${device_id}, is_verified = true WHERE id = ${user.id} AND app_id = ${APP_ID} RETURNING *`;
  const token = signToken({ sub: user.id, role: user.role, app_id: APP_ID }, env.JWT_SECRET);
  return json({ ok: true, token, user, next_step: 'role_selection' });
}

export async function onboardingRole(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const { role } = await parse(req); const normalizedRole = normalizeRole(role); if (!isAppUserRole(normalizedRole)) return json({ error: 'invalid role' }, 400); const [user] = await sql`UPDATE users SET role = ${normalizedRole} WHERE id = ${auth.sub} AND app_id = ${APP_ID} RETURNING *`; return json({ user, next_step: 'location' }); }
export async function onboardingLocation(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const { lat, lng, available } = await parse(req); const [user] = await sql`UPDATE users SET latitude = ${Number(lat)}, longitude = ${Number(lng)}, location_lat = ${Number(lat)}, location_lng = ${Number(lng)}, discoverable = ${available !== false} WHERE id = ${auth.sub} AND app_id = ${APP_ID} RETURNING id, role, location_lat, location_lng, discoverable`; return json({ user, next_step: 'consent' }); }
export async function onboardingConsent(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const { accepted_terms } = await parse(req); if (!accepted_terms) return json({ error: 'terms consent is mandatory' }, 400); await sql`INSERT INTO consents (app_id, user_id, accepted_terms, timestamp) VALUES (${APP_ID}, ${auth.sub}, true, NOW())`; return json({ ok: true, next_step: 'subscription' }); }

export async function onboardingSubscription(req, env) {
  const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error;
  const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401);
  const { action, plan_type, payment_reference, payment_proof_url } = await parse(req);
  const [user] = await sql`SELECT id, role FROM users WHERE id = ${auth.sub} AND app_id = ${APP_ID}`;
  if (user.role === 'CUSTOMER') { await sql`UPDATE users SET is_approved = true, verification_status = ${VERIFICATION_STATUS.APPROVED} WHERE id = ${auth.sub} AND app_id = ${APP_ID}`; return json({ ok: true, status: 'active', next_step: 'chat' }); }
  const selectedPlan = plan_type === 'yearly' ? 'yearly' : 'monthly';
  const { amount, gst, totalAmount } = calculatePlan(user.role, selectedPlan);
  const now = new Date(); const endDate = new Date(now); endDate.setMonth(endDate.getMonth() + (selectedPlan === 'yearly' ? 12 : 1));
  await sql`INSERT INTO subscriptions (app_id, user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, payment_proof_url, payment_reference, verified) VALUES (${APP_ID}, ${auth.sub}, ${user.role}, ${selectedPlan}, ${action === 'trial' ? 0 : amount}, ${action === 'trial' ? 0 : gst}, ${action === 'trial' ? 0 : totalAmount}, ${now.toISOString()}, ${endDate.toISOString()}, ${action === 'trial' ? SUB_STATUS.ACTIVE : SUB_STATUS.PENDING}, ${payment_proof_url || null}, ${payment_reference || null}, ${action === 'trial'})`;
  return json({ ok: true, status: action === 'trial' ? 'trial_active' : 'pending' });
}

export async function adminApproveOnboarding(req, env) { const sql = getDb(env); const guard = await requireSuperAdmin(req, env); if (guard.error) return guard.error; const { user_id, approved } = await parse(req); await sql`UPDATE users SET is_approved = ${!!approved}, verification_status = ${approved ? VERIFICATION_STATUS.APPROVED : VERIFICATION_STATUS.REJECTED} WHERE id = ${user_id} AND app_id = ${APP_ID}`; return json({ ok: true }); }
export async function subscriptionUpload(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const authRole = normalizeRole(auth.role); if (!isAppUserRole(authRole)) return json({ error: 'invalid role' }, 403); const { plan_type, payment_reference, payment_proof_url } = await parse(req); const { amount, gst, totalAmount } = calculatePlan(authRole, plan_type); const start = new Date(); const end = new Date(start); end.setMonth(end.getMonth() + (plan_type === 'yearly' ? 12 : 1)); const [row] = await sql`INSERT INTO subscriptions (app_id, user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, payment_proof_url, payment_reference, verified) VALUES (${APP_ID}, ${auth.sub}, ${authRole}, ${plan_type}, ${amount}, ${gst}, ${totalAmount}, ${start.toISOString()}, ${end.toISOString()}, ${SUB_STATUS.PENDING}, ${payment_proof_url}, ${payment_reference}, false) RETURNING *`; return json({ subscription: row }); }
export async function subscriptionVerify(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'web'); if (scope.error) return scope.error; const adminGuard = authorizeRoles('SUPER_ADMIN'); const guardResult = await adminGuard(req, env); if (guardResult.error) return guardResult.error; const { subscription_id, approved } = await parse(req); await sql`UPDATE subscriptions SET verified = ${!!approved}, status = ${approved ? SUB_STATUS.ACTIVE : SUB_STATUS.PENDING} WHERE id = ${subscription_id} AND app_id = ${APP_ID}`; return json({ ok: true }); }
export async function subscriptionStatus(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const [row] = await sql`SELECT * FROM subscriptions WHERE app_id = ${APP_ID} AND user_id = ${auth.sub} ORDER BY end_date DESC LIMIT 1`; return json({ subscription: row || null }); }

export async function nearbyDrivers(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const lat = Number(new URL(req.url).searchParams.get('lat')); const lng = Number(new URL(req.url).searchParams.get('lng')); const rows = await sql`SELECT id, name, role, latitude, longitude FROM users WHERE app_id = ${APP_ID} AND role = 'AUTO_DRIVER' AND active = true AND is_verified = true AND verification_status = 'approved' AND discoverable = true ORDER BY ((latitude - ${lat})^2 + (longitude - ${lng})^2) ASC LIMIT 25`; return json({ items: rows }); }
export async function nearbyShops(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const lat = Number(new URL(req.url).searchParams.get('lat')); const lng = Number(new URL(req.url).searchParams.get('lng')); const rows = await sql`SELECT id, name, role, latitude, longitude FROM users WHERE app_id = ${APP_ID} AND role = 'SHOP_OWNER' AND active = true AND is_verified = true AND verification_status = 'approved' AND discoverable = true ORDER BY ((latitude - ${lat})^2 + (longitude - ${lng})^2) ASC LIMIT 25`; return json({ items: rows }); }

export async function chatStart(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const { peer_id } = await parse(req); if (!(await canParticipate(sql, auth.sub)) || !(await canParticipate(sql, peer_id))) return json({ error: 'inactive account' }, 403); const [chat] = await sql`INSERT INTO chats (app_id, user_a, user_b) VALUES (${APP_ID}, ${auth.sub}, ${peer_id}) ON CONFLICT (user_a, user_b) DO UPDATE SET updated_at = NOW() RETURNING *`; return json({ chat }); }
export async function chatMessage(req, env) { const sql = getDb(env); const scope = enforceApp(req, 'pwa'); if (scope.error) return scope.error; const auth = await requireAuth(req, env); if (!auth || auth.app_id !== APP_ID) return json({ error: 'unauthorized' }, 401); const { chat_id, message_type, content } = await parse(req); const [msg] = await sql`INSERT INTO messages (app_id, chat_id, sender_id, message_type, content) VALUES (${APP_ID}, ${chat_id}, ${auth.sub}, ${message_type}, ${JSON.stringify(content)}) RETURNING *`; const softOrder = message_type === 'text' ? detectSoftOrder(content?.text || '') : null; if (softOrder) await sql`INSERT INTO orders (app_id, chat_id, user_id, order_payload, source, confidence) VALUES (${APP_ID}, ${chat_id}, ${auth.sub}, ${JSON.stringify(softOrder)}, 'nlp_soft_capture', ${softOrder.confidence})`; return json({ message: msg, soft_order: softOrder }); }

export async function analyticsById(req, env, userId) { const sql = getDb(env); const guard = await requireSuperAdmin(req, env); if (guard.error) return guard.error; const [summary] = await sql`SELECT COUNT(*) FILTER (WHERE event_type = 'order') AS orders, COUNT(*) FILTER (WHERE event_type = 'chat_message') AS messages, COALESCE(MAX(payload->>'top_item'), 'N/A') as top_item, COALESCE(MAX(payload->>'peak_time'), 'N/A') as peak_time FROM analytics_events WHERE app_id = ${APP_ID} AND user_id = ${userId} AND created_at::date = NOW()::date`; return json({ user_id: userId, today: summary }); }
