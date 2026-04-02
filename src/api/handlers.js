import { json } from '../core/response.js';
import { requireAuth, signToken } from '../core/auth.js';
import { getDb } from '../db/index.js';
import { APP_ID, ROLES, SUB_STATUS, VERIFICATION_STATUS } from '../types/constants.js';

const SUPER_ADMIN_EMAIL = 'abdulkareem@psmocollege.ac.in';
const OTP_EXPIRY_MINUTES = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 45;
const OTP_WINDOW_MINUTES = 10;
const OTP_MAX_REQUESTS = 3;
const WHATSAPP_VERIFY_TEXT = 'vyntaro verify my account.';

const sessionCache = new Map();

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits.startsWith('91') && digits.length === 12 ? `+${digits}` : `+${digits.replace(/^\+/, '')}`;
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'customer') return ROLES.CUSTOMER;
  if (value === 'auto driver' || value === 'auto_driver' || value === 'driver') return ROLES.AUTO_DRIVER;
  if (value === 'shop owner' || value === 'shop_owner' || value === 'shop') return ROLES.SHOP_OWNER;
  return null;
}

function generateSixDigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createOtpRecord(sql, { contact, channel, purpose }) {
  const otp = generateSixDigitOtp();
  const otpHash = await sha256Hex(otp);
  await sql`
    INSERT INTO otp_verifications (app_id, contact, channel, purpose, otp_hash, expiry, is_verified)
    VALUES (${APP_ID}, ${contact}, ${channel}, ${purpose}, ${otpHash}, NOW() + (${OTP_EXPIRY_MINUTES} * INTERVAL '1 minute'), false)
  `;
  return { otp, otpHash };
}

function enforceApp(req, channel) {
  const appId = req.headers.get('x-app-id');
  const clientChannel = req.headers.get('x-client-channel');
  if (appId !== APP_ID) return { error: json({ error: 'invalid app_id' }, 403) };
  if (channel && channel !== clientChannel) return { error: json({ error: `only ${channel} access allowed` }, 403) };
  return {};
}

async function parse(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function sendResendEmail(env, to, otp) {
  if (!env.RESEND_API_KEY) return { simulated: true };
  const payload = {
    from: 'noreply@aureliv.in',
    to: [to],
    subject: 'VYNTARO Admin OTP',
    html: `<p>Your VYNTARO admin OTP is <b>${otp}</b>. It expires in ${OTP_EXPIRY_MINUTES} minutes.</p>`
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend failed: ${body}`);
  }
  return { simulated: false };
}

async function sendWhatsAppOtp(env, phone, otp) {
  if (!env.WHATSAPP_API_URL || !env.WHATSAPP_API_TOKEN) return { simulated: true };
  const res = await fetch(env.WHATSAPP_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: phone,
      type: 'text',
      text: `Your VYNTARO OTP is ${otp}. Expires in ${OTP_EXPIRY_MINUTES} minutes.`
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed: ${body}`);
  }
  return { simulated: false };
}

async function requireSuperAdmin(req, env) {
  const scope = enforceApp(req, 'web');
  if (scope.error) return scope;
  const auth = await requireAuth(req, env);
  if (!auth) return { error: json({ error: 'unauthorized' }, 401) };
  if (auth.role !== ROLES.SUPER_ADMIN || normalizeEmail(auth.email) !== SUPER_ADMIN_EMAIL) {
    return { error: json({ error: 'forbidden' }, 403) };
  }
  return { auth };
}

async function upsertUser(sql, payload) {
  const {
    name = null,
    whatsappNumber,
    role,
    deviceId = null,
    lat = null,
    lng = null,
    address = null,
    isVerified = false,
    verificationStatus = VERIFICATION_STATUS.PENDING,
    isApproved = false
  } = payload;
  const [existing] = await sql`SELECT * FROM users WHERE app_id = ${APP_ID} AND phone = ${whatsappNumber} LIMIT 1`;
  if (existing) {
    const [updated] = await sql`
      UPDATE users
      SET name = COALESCE(${name}, name),
          role = COALESCE(${role}, role),
          device_id = COALESCE(${deviceId}, device_id),
          location_lat = COALESCE(${lat}, location_lat),
          location_lng = COALESCE(${lng}, location_lng),
          latitude = COALESCE(${lat}, latitude),
          longitude = COALESCE(${lng}, longitude),
          is_verified = ${isVerified || existing.is_verified},
          verification_status = COALESCE(${verificationStatus}, verification_status),
          is_approved = ${isApproved || existing.is_approved}
      WHERE id = ${existing.id} AND app_id = ${APP_ID}
      RETURNING *
    `;
    if (address) {
      await sql`UPDATE devices SET location = ${JSON.stringify({ lat, lng, address })} WHERE user_id = ${updated.id} AND app_id = ${APP_ID}`;
    }
    return updated;
  }

  const [created] = await sql`
    INSERT INTO users (app_id, name, phone, role, device_id, is_verified, verification_status, is_approved, location_lat, location_lng, latitude, longitude)
    VALUES (${APP_ID}, ${name}, ${whatsappNumber}, ${role || ROLES.CUSTOMER}, ${deviceId}, ${isVerified}, ${verificationStatus}, ${isApproved}, ${lat}, ${lng}, ${lat}, ${lng})
    RETURNING *
  `;
  if (deviceId) {
    await sql`INSERT INTO devices (app_id, user_id, device_id, last_login, location) VALUES (${APP_ID}, ${created.id}, ${deviceId}, NOW(), ${JSON.stringify({ lat, lng, address })})`;
  }
  return created;
}

async function createDeviceLog(sql, { userId, deviceId, location }) {
  const [existing] = await sql`SELECT id FROM devices WHERE app_id = ${APP_ID} AND user_id = ${userId} AND device_id = ${deviceId} LIMIT 1`;
  if (existing) {
    await sql`UPDATE devices SET last_login = NOW(), location = ${JSON.stringify(location || {})} WHERE id = ${existing.id}`;
    return;
  }
  await sql`INSERT INTO devices (app_id, user_id, device_id, last_login, location) VALUES (${APP_ID}, ${userId}, ${deviceId}, NOW(), ${JSON.stringify(location || {})})`;
}

export async function adminSendOtp(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'web');
  if (scope.error) return scope.error;
  const { email } = await parse(req);
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== SUPER_ADMIN_EMAIL) return json({ error: 'invalid admin email' }, 403);

  const [recent] = await sql`
    SELECT created_at FROM otp_verifications
    WHERE app_id = ${APP_ID} AND contact = ${normalizedEmail} AND channel = 'email' AND purpose = 'admin_login'
    ORDER BY created_at DESC LIMIT 1
  `;
  if (recent && Date.now() - new Date(recent.created_at).getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    return json({ error: 'otp recently sent, please wait' }, 429);
  }

  const { otp } = await createOtpRecord(sql, { contact: normalizedEmail, channel: 'email', purpose: 'admin_login' });
  await sendResendEmail(env, normalizedEmail, otp);
  return json({ ok: true, expiresInSeconds: OTP_EXPIRY_MINUTES * 60, ...(env.DEV_EXPOSE_OTP ? { otp } : {}) });
}

export async function adminVerifyOtp(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'web');
  if (scope.error) return scope.error;
  const { email, otp } = await parse(req);
  const normalizedEmail = normalizeEmail(email);
  const otpHash = await sha256Hex(String(otp || ''));
  const [row] = await sql`
    SELECT id, expiry FROM otp_verifications
    WHERE app_id = ${APP_ID} AND contact = ${normalizedEmail} AND channel = 'email' AND purpose = 'admin_login' AND otp_hash = ${otpHash} AND is_verified = false
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!row || new Date(row.expiry).getTime() < Date.now()) return json({ error: 'otp invalid/expired' }, 401);
  await sql`UPDATE otp_verifications SET is_verified = true WHERE id = ${row.id}`;
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({ email: normalizedEmail, role: ROLES.SUPER_ADMIN, app_id: APP_ID, iat: now, exp: now + 3600 }, env.JWT_SECRET);
  sessionCache.set(token, { role: ROLES.SUPER_ADMIN, email: normalizedEmail, exp: now + 3600 });
  return json({ token, role: ROLES.SUPER_ADMIN });
}

export async function whatsappInitiate(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'pwa');
  if (scope.error) return scope.error;
  const { whatsappNumber, deviceId } = await parse(req);
  const number = normalizePhone(whatsappNumber);
  if (!number || number.length < 8) return json({ error: 'invalid whatsapp number' }, 400);

  const [byDevice] = await sql`SELECT id, role, is_verified, is_approved FROM users WHERE app_id = ${APP_ID} AND device_id = ${deviceId} LIMIT 1`;
  if (byDevice?.is_verified) {
    const token = await signToken({ sub: byDevice.id, role: byDevice.role, app_id: APP_ID }, env.JWT_SECRET);
    return json({ ok: true, mode: 'device_login', token, user: byDevice });
  }

  const [user] = await sql`SELECT id, name, role, is_verified FROM users WHERE app_id = ${APP_ID} AND phone = ${number} LIMIT 1`;
  await sql`INSERT INTO onboarding_sessions (app_id, contact, device_id, status) VALUES (${APP_ID}, ${number}, ${deviceId || null}, 'pending') ON CONFLICT (app_id, contact) DO UPDATE SET device_id = EXCLUDED.device_id, status = 'pending', updated_at = NOW()`;
  return json({
    ok: true,
    exists: !!user,
    next: 'send_whatsapp_verify_message',
    instruction: 'Send "VYNTARO verify my account." from your WhatsApp to continue.'
  });
}

export async function whatsappWebhook(req, env) {
  const sql = getDb(env);
  const payload = await parse(req);
  const from = normalizePhone(payload.from || payload.wa_id || payload.phone);
  const body = String(payload.message || payload.text?.body || '').trim().toLowerCase();
  if (!from || body !== WHATSAPP_VERIFY_TEXT) return json({ ok: true, ignored: true });

  const [rate] = await sql`SELECT COUNT(*)::int AS count FROM otp_verifications WHERE app_id = ${APP_ID} AND contact = ${from} AND channel = 'whatsapp' AND created_at >= NOW() - (${OTP_WINDOW_MINUTES} * INTERVAL '1 minute')`;
  if (rate.count >= OTP_MAX_REQUESTS) return json({ error: 'too many otp requests' }, 429);

  const { otp } = await createOtpRecord(sql, { contact: from, channel: 'whatsapp', purpose: 'login' });
  await sendWhatsAppOtp(env, from, otp);
  return json({ ok: true, ...(env.DEV_EXPOSE_OTP ? { otp } : {}) });
}

export async function whatsappVerify(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'pwa');
  if (scope.error) return scope.error;
  const { whatsappNumber, otp, deviceId, location } = await parse(req);
  const number = normalizePhone(whatsappNumber);
  const otpHash = await sha256Hex(String(otp || ''));
  const [row] = await sql`SELECT id, expiry FROM otp_verifications WHERE app_id = ${APP_ID} AND contact = ${number} AND channel = 'whatsapp' AND purpose = 'login' AND otp_hash = ${otpHash} AND is_verified = false ORDER BY created_at DESC LIMIT 1`;
  if (!row || new Date(row.expiry).getTime() < Date.now()) return json({ error: 'otp invalid/expired' }, 401);

  await sql`UPDATE otp_verifications SET is_verified = true WHERE id = ${row.id}`;
  const user = await upsertUser(sql, {
    whatsappNumber: number,
    deviceId,
    lat: location?.lat ?? null,
    lng: location?.lng ?? null,
    address: location?.address ?? null,
    isVerified: true
  });
  await createDeviceLog(sql, {
    userId: user.id,
    deviceId,
    location
  });

  const token = await signToken({ sub: user.id, role: user.role, app_id: APP_ID }, env.JWT_SECRET);
  return json({ ok: true, token, user, next: user.name ? 'home' : 'registration' });
}

export async function registerUser(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'pwa');
  if (scope.error) return scope.error;
  const { name, whatsappNumber, role } = await parse(req);
  const resolvedRole = normalizeRole(role);
  if (!name || !resolvedRole) return json({ error: 'name and valid role are required' }, 400);
  const number = normalizePhone(whatsappNumber);
  const [existing] = await sql`SELECT id FROM users WHERE app_id = ${APP_ID} AND phone = ${number}`;
  if (existing) {
    await sql`UPDATE users SET name = ${name}, role = ${resolvedRole} WHERE id = ${existing.id}`;
    return json({ ok: true, userId: existing.id, role: resolvedRole });
  }
  const [created] = await sql`INSERT INTO users (app_id, name, phone, role, is_verified, verification_status, is_approved) VALUES (${APP_ID}, ${name}, ${number}, ${resolvedRole}, true, ${VERIFICATION_STATUS.PENDING}, ${resolvedRole === ROLES.CUSTOMER}) RETURNING id, role`;
  return json({ ok: true, userId: created.id, role: created.role });
}

export async function registerDriver(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'pwa');
  if (scope.error) return scope.error;
  const { userId, driverName, vehicleNumber, rcOwner, phone, location } = await parse(req);
  if (!vehicleNumber || !rcOwner) return json({ error: 'vehicleNumber and rcOwner are required' }, 400);
  const [user] = await sql`SELECT id FROM users WHERE app_id = ${APP_ID} AND id = ${userId}`;
  if (!user) return json({ error: 'user not found' }, 404);

  await sql`UPDATE users SET name = COALESCE(${driverName}, name), role = ${ROLES.AUTO_DRIVER}, phone = COALESCE(${normalizePhone(phone)}, phone), location_lat = COALESCE(${location?.lat ?? null}, location_lat), location_lng = COALESCE(${location?.lng ?? null}, location_lng), is_approved = false, verification_status = ${VERIFICATION_STATUS.PENDING} WHERE id = ${userId}`;
  await sql`INSERT INTO drivers (app_id, user_id, vehicle_number, rc_owner, approval_status) VALUES (${APP_ID}, ${userId}, ${vehicleNumber}, ${rcOwner}, 'pending') ON CONFLICT (user_id) DO UPDATE SET vehicle_number = EXCLUDED.vehicle_number, rc_owner = EXCLUDED.rc_owner, approval_status = 'pending'`;
  return json({ ok: true, approvalStatus: 'pending' });
}

export async function registerShop(req, env) {
  const sql = getDb(env);
  const scope = enforceApp(req, 'pwa');
  if (scope.error) return scope.error;
  const { userId, shopName, ownerName, shopAddress, category, phone, location } = await parse(req);
  if (!shopName || !shopAddress || !category) return json({ error: 'shopName, category and shopAddress are required' }, 400);

  await sql`UPDATE users SET name = COALESCE(${ownerName}, name), role = ${ROLES.SHOP_OWNER}, phone = COALESCE(${normalizePhone(phone)}, phone), location_lat = COALESCE(${location?.lat ?? null}, location_lat), location_lng = COALESCE(${location?.lng ?? null}, location_lng), is_approved = false, verification_status = ${VERIFICATION_STATUS.PENDING} WHERE id = ${userId} AND app_id = ${APP_ID}`;
  await sql`INSERT INTO shops (app_id, user_id, shop_name, category, address, lat, lng, approval_status) VALUES (${APP_ID}, ${userId}, ${shopName}, ${category}, ${shopAddress}, ${location?.lat ?? null}, ${location?.lng ?? null}, 'pending') ON CONFLICT (user_id) DO UPDATE SET shop_name = EXCLUDED.shop_name, category = EXCLUDED.category, address = EXCLUDED.address, lat = EXCLUDED.lat, lng = EXCLUDED.lng, approval_status = 'pending'`;
  return json({ ok: true, approvalStatus: 'pending' });
}

export async function adminUsers(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;
  const users = await sql`
    SELECT u.id, u.name, u.phone AS whatsapp_number, u.role, u.is_verified, u.is_approved, u.verification_status, u.device_id, u.location_lat, u.location_lng,
           d.approval_status AS driver_approval, s.approval_status AS shop_approval,
           sub.plan_type, sub.start_date, sub.end_date, sub.status AS subscription_status
    FROM users u
    LEFT JOIN drivers d ON d.user_id = u.id AND d.app_id = u.app_id
    LEFT JOIN shops s ON s.user_id = u.id AND s.app_id = u.app_id
    LEFT JOIN LATERAL (
      SELECT plan_type, start_date, end_date, status
      FROM subscriptions ss
      WHERE ss.user_id = u.id AND ss.app_id = u.app_id
      ORDER BY created_at DESC LIMIT 1
    ) sub ON true
    WHERE u.app_id = ${APP_ID}
    ORDER BY u.created_at DESC
    LIMIT 500
  `;

  const deviceLogs = await sql`SELECT user_id, device_id, last_login, location FROM devices WHERE app_id = ${APP_ID} ORDER BY last_login DESC LIMIT 500`;
  return json({ items: users, deviceLogs });
}

export async function adminApprove(req, env) {
  const sql = getDb(env);
  const guard = await requireSuperAdmin(req, env);
  if (guard.error) return guard.error;

  const { userId, approve = true, trial = false, planType = null } = await parse(req);
  const [user] = await sql`SELECT id, role FROM users WHERE app_id = ${APP_ID} AND id = ${userId}`;
  if (!user) return json({ error: 'user not found' }, 404);

  await sql`UPDATE users SET is_approved = ${!!approve}, verification_status = ${approve ? VERIFICATION_STATUS.APPROVED : VERIFICATION_STATUS.REJECTED} WHERE id = ${user.id}`;
  if (user.role === ROLES.AUTO_DRIVER) {
    await sql`UPDATE drivers SET approval_status = ${approve ? 'approved' : 'rejected'} WHERE user_id = ${user.id} AND app_id = ${APP_ID}`;
  }
  if (user.role === ROLES.SHOP_OWNER) {
    await sql`UPDATE shops SET approval_status = ${approve ? 'approved' : 'rejected'} WHERE user_id = ${user.id} AND app_id = ${APP_ID}`;
  }

  if (approve && (trial || planType)) {
    const selectedPlan = trial ? 'monthly' : (planType === 'yearly' ? 'yearly' : 'monthly');
    const start = new Date();
    const expiry = new Date(start);
    expiry.setMonth(expiry.getMonth() + (selectedPlan === 'yearly' ? 12 : 1));
    await sql`INSERT INTO subscriptions (app_id, user_id, role, plan_type, amount, gst, total_amount, start_date, end_date, status, verified) VALUES (${APP_ID}, ${user.id}, ${user.role}, ${selectedPlan}, 0, 0, 0, ${start.toISOString()}, ${expiry.toISOString()}, ${SUB_STATUS.ACTIVE}, true)`;
  }

  return json({ ok: true });
}

// Backward compatible legacy handlers
export const login = whatsappVerify;
export const onboardingRequestOtp = whatsappInitiate;
export const onboardingVerifyOtp = whatsappVerify;
export const onboardingVerify = registerUser;
export const onboardingRole = registerUser;
export const onboardingLocation = registerUser;
export const onboardingConsent = registerUser;
export const onboardingSubscription = registerUser;
export const onboardingStatus = whatsappInitiate;
export const adminApproveOnboarding = adminApprove;
export const subscriptionUpload = adminApprove;
export const subscriptionVerify = adminApprove;
export const subscriptionStatus = adminUsers;
export const nearbyDrivers = adminUsers;
export const nearbyShops = adminUsers;
export const chatStart = adminUsers;
export const chatMessage = adminUsers;
export const analyticsById = adminUsers;
export const adminChats = adminUsers;
export const adminSubscriptions = adminUsers;
export const adminAnalytics = adminUsers;


export const __test = {
  normalizeEmail,
  normalizePhone,
  normalizeRole,
  generateSixDigitOtp,
  sha256Hex
};
