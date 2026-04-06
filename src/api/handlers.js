import { json } from '../core/response.js';
import { requireAuth, signToken } from '../core/auth.js';
import { getDb } from '../db/index.js';
import { redisDel, redisGet, redisSetEx } from '../core/redis.js';
import { APP_ID, ONBOARDING_STATUS, PAID_ROLES, PLAN_TYPES, ROLES, SUB_STATUS } from '../types/constants.js';
import { activateSubscription, calculatePlan } from '../services/subscription.js';

const OTP_EXPIRY_SECONDS = 300;
const OTP_RATE_WINDOW_SECONDS = 600;
const OTP_MAX_PER_WINDOW = 5;
const VERIFY_PHONE = '+919744917623';
const VERIFY_TEXT = 'VYNTARO verify my number';

function normalizePhone(raw, countryCode = '+91') {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 10) return `${countryCode}${digits}`;
  return digits.startsWith('91') ? `+${digits}` : `+${digits}`;
}

function normalizeRole(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (value in ROLES) return ROLES[value];
  return null;
}

function parseCountryCode(req) {
  const locale = req.headers.get('cf-ipcountry') || req.headers.get('x-locale-country') || 'IN';
  if (locale === 'IN') return '+91';
  if (locale === 'US') return '+1';
  return '+91';
}

function parseDeviceId(req, body) {
  const provided = String(body?.deviceId || '').trim();
  if (provided) return provided;
  const ua = req.headers.get('user-agent') || 'unknown';
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  return `fp:${ip}:${ua}`.slice(0, 255);
}

function sixDigitOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ensureApp(req, expectedChannel = null) {
  if (req.headers.get('x-app-id') !== APP_ID) return json({ error: 'invalid app id' }, 403);
  if (expectedChannel && req.headers.get('x-client-channel') !== expectedChannel) return json({ error: 'invalid channel' }, 403);
  return null;
}

async function parse(req) { try { return await req.json(); } catch { return {}; } }

async function currentSubscription(sql, userId) {
  const [sub] = await sql`
    SELECT * FROM subscriptions
    WHERE app_id = ${APP_ID} AND user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return sub || null;
}

async function hasActiveSubscription(sql, user) {
  if (!PAID_ROLES.has(user.role)) return true;
  const sub = await currentSubscription(sql, user.id);
  if (!sub) return false;
  return sub.status === SUB_STATUS.ACTIVE && new Date(sub.end_date).getTime() > Date.now();
}

async function bindDevice(sql, userId, deviceId, location = null) {
  await sql`
    INSERT INTO devices (app_id, user_id, device_id, latitude, longitude, location, last_login)
    VALUES (${APP_ID}, ${userId}, ${deviceId}, ${location?.lat ?? null}, ${location?.lng ?? null}, ${JSON.stringify(location || {})}, NOW())
    ON CONFLICT (app_id, user_id, device_id)
    DO UPDATE SET
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      location = EXCLUDED.location,
      last_login = NOW()
  `;
}

async function sendOtpViaProvider(env, phone, otp) {
  if (!env.WHATSAPP_API_URL || !env.WHATSAPP_API_TOKEN) return { simulated: true };
  const res = await fetch(env.WHATSAPP_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: phone,
      message: `Your VYNTARO OTP is ${otp}. Valid for 5 minutes.`
    })
  });
  if (!res.ok) throw new Error(`whatsapp provider error: ${res.status}`);
  return { simulated: false };
}

export async function requestWhatsapp(req, env) {
  const blocked = ensureApp(req, 'pwa');
  if (blocked) return blocked;
  const body = await parse(req);
  const countryCode = parseCountryCode(req);
  const phone = normalizePhone(body.phone, countryCode);
  if (!phone || phone.length < 8) return json({ error: 'invalid phone' }, 400);
  const deviceId = parseDeviceId(req, body);
  const sql = getDb(env);

  const [userByDevice] = await sql`SELECT u.* FROM users u JOIN devices d ON d.user_id = u.id AND d.app_id = u.app_id WHERE u.app_id = ${APP_ID} AND d.device_id = ${deviceId} ORDER BY d.last_login DESC LIMIT 1`;
  if (userByDevice?.phone_verified) {
    const token = await signToken({ sub: userByDevice.id, role: userByDevice.role, app_id: APP_ID }, env.JWT_SECRET);
    await bindDevice(sql, userByDevice.id, deviceId, body.location || null);
    return json({ ok: true, mode: 'device_login', token, user: userByDevice, next: '/chat' });
  }

  await sql`
    INSERT INTO onboarding_sessions (app_id, phone, device_id, country_code, status)
    VALUES (${APP_ID}, ${phone}, ${deviceId}, ${countryCode}, 'pending')
    ON CONFLICT (app_id, phone)
    DO UPDATE SET device_id = EXCLUDED.device_id, country_code = EXCLUDED.country_code, status = 'pending', updated_at = NOW()
  `;

  return json({
    ok: true,
    countryCode,
    phone,
    verification: {
      to: VERIFY_PHONE,
      message: VERIFY_TEXT,
      whatsappDeepLink: `whatsapp://send?phone=${VERIFY_PHONE.replace(/\D/g, '')}&text=${encodeURIComponent(VERIFY_TEXT)}`,
      whatsappWebLink: `https://wa.me/${VERIFY_PHONE.replace(/\D/g, '')}?text=${encodeURIComponent(VERIFY_TEXT)}`
    }
  });
}

export async function whatsappWebhook(req, env) {
  if (env.WHATSAPP_WEBHOOK_SECRET && req.headers.get('x-webhook-secret') !== env.WHATSAPP_WEBHOOK_SECRET) {
    return json({ error: 'invalid webhook secret' }, 401);
  }

  const payload = await parse(req);
  const from = normalizePhone(payload?.from || payload?.wa_id || payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from);
  const text = String(payload?.message || payload?.text?.body || payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body || '').trim().toLowerCase();
  if (!from || !text.includes('vyntaro verify')) return json({ ok: true, ignored: true });

  const sql = getDb(env);
  const [session] = await sql`SELECT id FROM onboarding_sessions WHERE app_id = ${APP_ID} AND phone = ${from} AND status IN ('pending', 'otp_sent') LIMIT 1`;
  if (!session) return json({ ok: true, ignored: true, reason: 'session_not_found' });

  const rateKey = `otp-rate:${from}`;
  const rate = await redisGet(env, rateKey) || { count: 0 };
  if (rate.count >= OTP_MAX_PER_WINDOW) return json({ error: 'too many otp requests' }, 429);
  await redisSetEx(env, rateKey, OTP_RATE_WINDOW_SECONDS, { count: rate.count + 1 });

  const otp = sixDigitOtp();
  const otpHash = await sha256Hex(otp);
  await redisSetEx(env, `otp:${from}`, OTP_EXPIRY_SECONDS, { otpHash, createdAt: Date.now() });
  await sql`INSERT INTO otp_verifications (app_id, phone, otp_hash, expiry, channel, purpose, verified) VALUES (${APP_ID}, ${from}, ${otpHash}, NOW() + INTERVAL '5 minutes', 'whatsapp', 'login', false)`;
  await sql`UPDATE onboarding_sessions SET status = 'otp_sent', updated_at = NOW() WHERE id = ${session.id}`;
  await sendOtpViaProvider(env, from, otp);

  return json({ ok: true, ...(env.DEV_EXPOSE_OTP ? { otp } : {}) });
}

export async function verifyOtp(req, env) {
  const blocked = ensureApp(req, 'pwa');
  if (blocked) return blocked;
  const body = await parse(req);
  const phone = normalizePhone(body.phone, parseCountryCode(req));
  const otp = String(body.otp || '').trim();
  const deviceId = parseDeviceId(req, body);
  if (!phone || !/^\d{6}$/.test(otp)) return json({ error: 'phone and valid otp required' }, 400);

  const cached = await redisGet(env, `otp:${phone}`);
  const hash = await sha256Hex(otp);
  if (!cached || cached.otpHash !== hash) return json({ error: 'invalid_or_expired_otp' }, 401);

  const sql = getDb(env);
  await redisDel(env, `otp:${phone}`);
  await sql`UPDATE otp_verifications SET verified = true WHERE app_id = ${APP_ID} AND phone = ${phone} AND otp_hash = ${hash} AND verified = false`;

  let [user] = await sql`SELECT * FROM users WHERE app_id = ${APP_ID} AND phone = ${phone} LIMIT 1`;
  if (!user) {
    [user] = await sql`INSERT INTO users (app_id, phone, role, phone_verified, onboarding_status) VALUES (${APP_ID}, ${phone}, ${ROLES.CUSTOMER}, true, ${ONBOARDING_STATUS.PENDING}) RETURNING *`;
  } else {
    [user] = await sql`UPDATE users SET phone_verified = true, updated_at = NOW() WHERE id = ${user.id} RETURNING *`;
  }

  await bindDevice(sql, user.id, deviceId, body.location || null);

  const token = await signToken({ sub: user.id, role: user.role, app_id: APP_ID }, env.JWT_SECRET);
  return json({ ok: true, token, user, next: '/onboarding' });
}

export async function onboarding(req, env) {
  const blocked = ensureApp(req, 'pwa');
  if (blocked) return blocked;
  const auth = await requireAuth(req, env);
  if (!auth?.sub) return json({ error: 'unauthorized' }, 401);
  const body = await parse(req);

  const role = normalizeRole(body.role);
  if (!body.name || !role) return json({ error: 'name and valid role required' }, 400);
  if (!body.acceptTerms || !body.acceptPrivacy) return json({ error: 'terms and privacy acceptance required' }, 400);

  const sql = getDb(env);
  const [user] = await sql`
    UPDATE users
    SET name = ${String(body.name).trim()}, role = ${role}, terms_accepted = true, privacy_accepted = true,
        location_lat = COALESCE(${body.location?.lat ?? null}, location_lat),
        location_lng = COALESCE(${body.location?.lng ?? null}, location_lng),
        onboarding_status = ${role === ROLES.CUSTOMER ? ONBOARDING_STATUS.APPROVED : ONBOARDING_STATUS.PENDING},
        updated_at = NOW()
    WHERE app_id = ${APP_ID} AND id = ${auth.sub}
    RETURNING *
  `;

  if (!user) return json({ error: 'user_not_found' }, 404);

  if (role === ROLES.VENDOR) {
    const profile = body.vendorProfile || {};
    if (!profile.shopName || !profile.category || !body.location?.lat || !body.location?.lng) return json({ error: 'vendor profile incomplete' }, 400);
    await sql`
      INSERT INTO vendor_profiles (app_id, user_id, shop_name, category, contact_details, working_hours, address, latitude, longitude)
      VALUES (${APP_ID}, ${user.id}, ${profile.shopName}, ${profile.category}, ${profile.contactDetails || null}, ${profile.workingHours || null}, ${profile.address || null}, ${body.location.lat}, ${body.location.lng})
      ON CONFLICT (user_id) DO UPDATE SET
        shop_name = EXCLUDED.shop_name,
        category = EXCLUDED.category,
        contact_details = EXCLUDED.contact_details,
        working_hours = EXCLUDED.working_hours,
        address = EXCLUDED.address,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        updated_at = NOW()
    `;
  }

  if (role === ROLES.DRIVER) {
    const profile = body.driverProfile || {};
    if (!profile.vehicleType || !profile.licenseDetails || !profile.availability) return json({ error: 'driver profile incomplete' }, 400);
    await sql`
      INSERT INTO driver_profiles (app_id, user_id, vehicle_type, license_details, availability)
      VALUES (${APP_ID}, ${user.id}, ${profile.vehicleType}, ${profile.licenseDetails}, ${profile.availability})
      ON CONFLICT (user_id) DO UPDATE SET
        vehicle_type = EXCLUDED.vehicle_type,
        license_details = EXCLUDED.license_details,
        availability = EXCLUDED.availability,
        updated_at = NOW()
    `;
  }

  if (role === ROLES.SERVICE_PROVIDER) {
    const profile = body.serviceProfile || {};
    if (!profile.serviceType || !profile.serviceArea) return json({ error: 'service profile incomplete' }, 400);
    await sql`
      INSERT INTO service_profiles (app_id, user_id, service_type, service_area, experience_years)
      VALUES (${APP_ID}, ${user.id}, ${profile.serviceType}, ${profile.serviceArea}, ${Number(profile.experienceYears || 0) || null})
      ON CONFLICT (user_id) DO UPDATE SET
        service_type = EXCLUDED.service_type,
        service_area = EXCLUDED.service_area,
        experience_years = EXCLUDED.experience_years,
        updated_at = NOW()
    `;
  }

  return json({
    ok: true,
    onboardingStatus: user.onboarding_status,
    requiresSubscription: PAID_ROLES.has(role),
    next: '/chat'
  });
}

async function verifyRazorpaySignature(orderId, paymentId, signature, secret) {
  if (!secret) return true;
  const data = `${orderId}|${paymentId}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const hex = Array.from(new Uint8Array(signed)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === signature;
}

export async function subscriptionActivate(req, env) {
  const blocked = ensureApp(req, 'pwa');
  if (blocked) return blocked;
  const auth = await requireAuth(req, env);
  if (!auth?.sub) return json({ error: 'unauthorized' }, 401);
  const body = await parse(req);
  const planType = body.planType === PLAN_TYPES.YEARLY ? PLAN_TYPES.YEARLY : PLAN_TYPES.MONTHLY;

  const sql = getDb(env);
  const [user] = await sql`SELECT * FROM users WHERE app_id = ${APP_ID} AND id = ${auth.sub} LIMIT 1`;
  if (!user) return json({ error: 'user_not_found' }, 404);
  if (!PAID_ROLES.has(user.role)) return json({ ok: true, message: 'customer plan is always free' });

  const plan = calculatePlan(user.role, planType);

  if (!body.razorpayPaymentId || !body.razorpayOrderId || !body.razorpaySignature) {
    return json({
      ok: true,
      mode: 'create_order',
      amountPaise: Math.round(plan.totalAmount * 100),
      currency: plan.currency,
      planType,
      launchOfferApplied: plan.totalAmount === 69 || plan.totalAmount === 699
    });
  }

  const validSig = await verifyRazorpaySignature(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature, env.RAZORPAY_KEY_SECRET);
  if (!validSig) return json({ error: 'invalid_payment_signature' }, 401);

  const subscription = await activateSubscription(sql, {
    userId: user.id,
    role: user.role,
    planType,
    razorpayOrderId: body.razorpayOrderId,
    razorpayPaymentId: body.razorpayPaymentId,
    razorpaySignature: body.razorpaySignature,
    status: SUB_STATUS.ACTIVE
  });

  return json({ ok: true, subscription });
}

export async function userProfile(req, env) {
  const blocked = ensureApp(req, 'pwa');
  if (blocked) return blocked;
  const auth = await requireAuth(req, env);
  if (!auth?.sub) return json({ error: 'unauthorized' }, 401);
  const sql = getDb(env);
  const [user] = await sql`SELECT * FROM users WHERE app_id = ${APP_ID} AND id = ${auth.sub}`;
  if (!user) return json({ error: 'user_not_found' }, 404);
  const subscription = await currentSubscription(sql, user.id);

  const visibleForLeads = user.onboarding_status === ONBOARDING_STATUS.APPROVED && await hasActiveSubscription(sql, user);
  return json({ user, subscription, visibleForLeads });
}

export async function onboardingDecision(req, env) {
  const blocked = ensureApp(req, 'web');
  if (blocked) return blocked;
  const auth = await requireAuth(req, env);
  if (!auth || auth.role !== ROLES.SUPER_ADMIN) return json({ error: 'forbidden' }, 403);
  const body = await parse(req);
  const sql = getDb(env);

  const next = body.approved ? ONBOARDING_STATUS.APPROVED : ONBOARDING_STATUS.REJECTED;
  const [user] = await sql`UPDATE users SET onboarding_status = ${next}, updated_at = NOW() WHERE app_id = ${APP_ID} AND id = ${body.userId} RETURNING *`;
  if (!user) return json({ error: 'user_not_found' }, 404);
  return json({ ok: true, userId: user.id, onboardingStatus: user.onboarding_status });
}

// compatibility exports
export const whatsappInitiate = requestWhatsapp;
export const whatsappVerify = verifyOtp;
export const registerUser = onboarding;
export const registerShop = onboarding;
export const registerDriver = onboarding;
export const adminApprove = onboardingDecision;
export const adminUsers = userProfile;
export const nearbyDrivers = userProfile;
export const chatStart = userProfile;
export const chatMessage = userProfile;
export const adminSendOtp = requestWhatsapp;
export const adminVerifyOtp = verifyOtp;

export const __test = { normalizePhone, normalizeRole, sha256Hex, sixDigitOtp };


export const analyticsById = userProfile;
export const nearbyShops = userProfile;
export const adminChats = userProfile;
export const adminSubscriptions = userProfile;
export const adminAnalytics = userProfile;
