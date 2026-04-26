import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Redis from 'ioredis';
import { Queue, Worker as BullWorker } from 'bullmq';
import {
  PrismaClient,
  Prisma,
  Role,
  VendorCategory,
  VehicleType,
  OrderType,
  OrderStatus,
  OnboardingType,
  OnboardingStatus,
  LeadIntent,
  LeadStatus,
  SubscriptionType,
  VendorStatus,
  PaymentStatus,
  LeadEventType,
  ApprovalStatus
} from '@prisma/client';
import { attachChatWebSocketServer } from './chat/ws-server.js';
import { routeChatMessage } from './chat/chat-router.js';

process.on('unhandledRejection', (error) => {
  console.error('unhandled_rejection', error);
});

process.on('uncaughtException', (error) => {
  console.error('uncaught_exception', error);
});

const app = express();
const prisma = new PrismaClient();
app.use(express.json({ limit: '1mb' }));

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', corsOrigin);
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-device-id,x-app-id,x-client-channel,x-api-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

const inMemoryCache = new Map();
const inMemoryRateLimit = new Map();

const AUTH_ROLES = {
  CUSTOMER: Role.CUSTOMER,
  VENDOR: Role.VENDOR,
  DRIVER: Role.DRIVER,
  SERVICE_PROVIDER: Role.SERVICE_AGENT,
  ADMIN: Role.ADMIN
};

const SUBSCRIPTION_RANK_BOOST = {
  [SubscriptionType.FREE]: 0,
  [SubscriptionType.BASIC]: 10,
  [SubscriptionType.PREMIUM]: 25
};

const RATE_LIMITS = {
  customerChat: { limit: 30, windowSec: 60 },
  vendorApi: { limit: 120, windowSec: 60 }
};

const DIAL_CODES = {
  IN: '+91', US: '+1', CA: '+1', GB: '+44', AE: '+971', SA: '+966', AU: '+61', SG: '+65'
};

const SUBSCRIPTION_PRICE_BOOK = {
  monthly: { standard: 99, launch: 69, months: 1 },
  yearly: { standard: 999, launch: 699, months: 12 }
};
const LAUNCH_OFFER_END_UTC = new Date('2026-05-31T23:59:59.999Z').getTime();

const redisEnabled = Boolean(process.env.REDIS_URL);
const redis = redisEnabled ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 }) : null;
const queueConnection = redisEnabled ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) : null;

const queues = queueConnection
  ? {
      notifications: new Queue('notifications', { connection: queueConnection }),
      orders: new Queue('orders', { connection: queueConnection }),
      analytics: new Queue('analytics', { connection: queueConnection })
    }
  : null;

if (queueConnection && process.env.ENABLE_BACKGROUND_WORKERS === 'true') {
  new BullWorker('notifications', async (job) => {
    console.log('notification_job', job.name, job.data);
  }, { connection: queueConnection });

  new BullWorker('orders', async (job) => {
    console.log('order_job', job.name, job.data);
  }, { connection: queueConnection });

  new BullWorker('analytics', async (job) => {
    const payload = job.data || {};
    await prisma.analyticsMetric.create({
      data: {
        metricDate: new Date(),
        category: String(payload.category || 'GENERAL'),
        searches: Number(payload.searches || 0),
        chatsStarted: Number(payload.chatsStarted || 0),
        leadsQualified: Number(payload.leadsQualified || 0),
        ordersCreated: Number(payload.ordersCreated || 0),
        conversionRate: Number(payload.conversionRate || 0),
        revenue: Number(payload.revenue || 0)
      }
    });
  }, { connection: queueConnection });
}

function jsonError(res, status, error) {
  return res.status(status).json({ error });
}

function detectCountryCode(req) {
  const country = String(req.headers['cf-ipcountry'] || req.headers['x-country-code'] || 'US').toUpperCase();
  return DIAL_CODES[country] || '+1';
}

function normalizePhone(phone, fallbackCode = '+1') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 10) return `${fallbackCode}${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function isLaunchOfferActive() {
  return Date.now() <= LAUNCH_OFFER_END_UTC;
}

function planPrice(planType) {
  const plan = SUBSCRIPTION_PRICE_BOOK[planType] || SUBSCRIPTION_PRICE_BOOK.monthly;
  return {
    amount: isLaunchOfferActive() ? plan.launch : plan.standard,
    months: plan.months,
    launchOfferApplied: isLaunchOfferActive()
  };
}

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return jsonError(res, 401, 'missing token');
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const deviceId = String(req.headers['x-device-id'] || '');
    const activeSession = await prisma.userSession.findFirst({
      where: {
        userId: claims.sub,
        jwtId: claims.jti,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        ...(deviceId ? { deviceId } : {})
      }
    });
    if (!activeSession) return jsonError(res, 401, 'session_expired');
    await prisma.userSession.update({ where: { id: activeSession.id }, data: { lastSeenAt: new Date() } });
    req.user = claims;
    return next();
  } catch {
    return jsonError(res, 401, 'invalid token');
  }
}

function allow(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return jsonError(res, 403, 'forbidden');
    return next();
  };
}

async function rateLimit(req, res, next) {
  const isVendor = req.user?.role === Role.VENDOR;
  const policy = isVendor ? RATE_LIMITS.vendorApi : RATE_LIMITS.customerChat;
  const scope = isVendor ? 'vendor' : 'customer';
  const key = `${scope}:${req.user?.sub || req.ip}`;

  if (!redis) {
    const now = Date.now();
    const hit = inMemoryRateLimit.get(key);
    if (!hit || hit.expireAt < now) {
      inMemoryRateLimit.set(key, { count: 1, expireAt: now + policy.windowSec * 1000 });
      return next();
    }
    hit.count += 1;
    if (hit.count > policy.limit) return jsonError(res, 429, 'rate_limit_exceeded');
    return next();
  }

  const redisKey = `rate:${key}`;
  const tx = redis.multi();
  tx.incr(redisKey);
  tx.expire(redisKey, policy.windowSec, 'NX');
  const [[, count]] = await tx.exec();
  if (Number(count) > policy.limit) return jsonError(res, 429, 'rate_limit_exceeded');
  return next();
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = (bLat - aLat) * (Math.PI / 180);
  const dLng = (bLng - aLng) * (Math.PI / 180);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function boundingBox(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta
  };
}

function parsePagination(query) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(50, Math.max(1, Number(query.pageSize || 10)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function intentFromMessage(text) {
  const msg = String(text || '').toLowerCase();
  if (!msg.trim()) return { intent: LeadIntent.UNKNOWN, keyword: '' };
  if (/auto|taxi|cab|ride/.test(msg)) return { intent: LeadIntent.AUTO, keyword: msg.replace(/auto|taxi|cab|ride/gi, '').trim() || 'ride' };
  if (/plumber|electrician|service|repair|delivery/.test(msg)) return { intent: LeadIntent.SERVICE, keyword: msg.trim() };
  return { intent: LeadIntent.SHOPPING, keyword: msg.replace(/i need|want|buy|shop|shopping/gi, '').trim() || msg.trim() };
}

function chatModuleToIntent(module) {
  if (module === 'AUTO' || module === 'TAXI') return LeadIntent.AUTO;
  if (module === 'SERVICE') return LeadIntent.SERVICE;
  if (module === 'SHOPPING') return LeadIntent.SHOPPING;
  return LeadIntent.UNKNOWN;
}

async function discoverNearbyByModule({ prisma, module, sourceLat, sourceLng, maxResults = 5 }) {
  if (!module || !Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) return [];
  const box = boundingBox(sourceLat, sourceLng, 8);

  if (module === 'SHOPPING') {
    const vendors = await prisma.vendor.findMany({
      where: {
        status: VendorStatus.ACTIVE,
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng }
      },
      include: { user: { select: { name: true, phone: true } } },
      take: 15
    });
    return vendors
      .map((v) => ({
        id: v.id,
        kind: 'vendor',
        name: v.user?.name || 'Vendor',
        distanceKm: distanceKm(sourceLat, sourceLng, v.latitude, v.longitude),
        whatsappLink: `https://wa.me/${(v.user?.phone || '').replace(/[^\d]/g, '')}`
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, maxResults);
  }

  if (module === 'AUTO' || module === 'TAXI') {
    const drivers = await prisma.driver.findMany({
      where: {
        isAvailable: true,
        vehicleType: module === 'AUTO' ? VehicleType.AUTO : VehicleType.TAXI,
        user: {
          lastLatitude: { gte: box.minLat, lte: box.maxLat },
          lastLongitude: { gte: box.minLng, lte: box.maxLng }
        }
      },
      include: { user: { select: { name: true, phone: true, lastLatitude: true, lastLongitude: true } } },
      take: 15
    });
    return drivers
      .map((d) => ({
        id: d.id,
        kind: 'driver',
        name: d.user?.name || `${module} Driver`,
        vehicleType: d.vehicleType,
        distanceKm: distanceKm(sourceLat, sourceLng, d.user?.lastLatitude || sourceLat, d.user?.lastLongitude || sourceLng),
        whatsappLink: `https://wa.me/${(d.user?.phone || '').replace(/[^\d]/g, '')}`
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, maxResults);
  }

  const agents = await prisma.serviceAgent.findMany({
    where: {
      isAvailable: true,
      user: {
        lastLatitude: { gte: box.minLat, lte: box.maxLat },
        lastLongitude: { gte: box.minLng, lte: box.maxLng }
      }
    },
    include: { user: { select: { name: true, phone: true, lastLatitude: true, lastLongitude: true } } },
    take: 15
  });
  return agents
    .map((agent) => ({
      id: agent.id,
      kind: 'service_agent',
      name: agent.user?.name || 'Service Provider',
      serviceType: agent.serviceType,
      distanceKm: distanceKm(sourceLat, sourceLng, agent.user?.lastLatitude || sourceLat, agent.user?.lastLongitude || sourceLng),
      whatsappLink: `https://wa.me/${(agent.user?.phone || '').replace(/[^\d]/g, '')}`
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, maxResults);
}

async function cacheGet(cacheKey) {
  if (redis) {
    const value = await redis.get(cacheKey);
    return value ? JSON.parse(value) : null;
  }
  const hit = inMemoryCache.get(cacheKey);
  if (!hit || hit.expiresAt < Date.now()) return null;
  return hit.value;
}

async function cacheSet(cacheKey, value, ttlSec) {
  if (redis) {
    await redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSec);
    return;
  }
  inMemoryCache.set(cacheKey, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

function buildVendorScore(candidate) {
  const distanceWeight = Math.max(0, 50 - candidate.distanceKm * 8);
  const ratingWeight = Math.min(25, candidate.rating * 5);
  const responseWeight = Math.max(0, 10 - Math.min(10, candidate.avgResponseSeconds / 30));
  const tierWeight = SUBSCRIPTION_RANK_BOOST[candidate.subscriptionType] || 0;
  const paidBoost = Math.min(30, candidate.activePromotionBoost + candidate.paidBoost + candidate.priorityScore);
  const score = distanceWeight + ratingWeight + responseWeight + tierWeight + paidBoost;
  return {
    ...candidate,
    score: Math.round(score * 100) / 100,
    rankSignals: { distanceWeight, ratingWeight, responseWeight, tierWeight, paidBoost }
  };
}

function isPaidRole(role) {
  return [Role.VENDOR, Role.DRIVER, Role.SERVICE_AGENT].includes(role);
}

async function ensureCoreAuthSchema() {
  const bootstrapSql = `
DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('CUSTOMER','VENDOR','DRIVER','SERVICE_AGENT','ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT,
  "phone" TEXT UNIQUE NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
  "countryCode" TEXT DEFAULT '+1',
  "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
  "lastLatitude" DOUBLE PRECISION,
  "lastLongitude" DOUBLE PRECISION,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "OtpVerification" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
  "phone" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "consumedAt" TIMESTAMPTZ,
  "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
  "provider" TEXT NOT NULL DEFAULT 'INTERNAL',
  "purpose" TEXT NOT NULL DEFAULT 'LOGIN',
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "OtpVerification_phone_createdAt_idx" ON "OtpVerification" ("phone", "createdAt");
CREATE INDEX IF NOT EXISTS "OtpVerification_phone_expiresAt_idx" ON "OtpVerification" ("phone", "expiresAt");
CREATE TABLE IF NOT EXISTS "UserSession" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "deviceId" TEXT NOT NULL,
  "jwtId" TEXT UNIQUE NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "UserSession_userId_deviceId_idx" ON "UserSession" ("userId", "deviceId");
CREATE INDEX IF NOT EXISTS "UserSession_expiresAt_revokedAt_idx" ON "UserSession" ("expiresAt", "revokedAt");
CREATE TABLE IF NOT EXISTS roles (
  "id" TEXT PRIMARY KEY,
  "name" TEXT UNIQUE NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_roles (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "roleId" TEXT NOT NULL REFERENCES roles("id") ON DELETE CASCADE,
  "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("userId", "roleId")
);
CREATE INDEX IF NOT EXISTS "user_roles_roleId_assignedAt_idx" ON user_roles ("roleId", "assignedAt");
`;

  await prisma.$executeRawUnsafe(bootstrapSql);
}

async function syncUserRole(userId, roleName) {
  const normalized = String(roleName || '').toLowerCase();
  if (!normalized) return;
  const role = await prisma.roleDefinition.upsert({
    where: { name: normalized },
    update: { isActive: true },
    create: { name: normalized, isActive: true }
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    update: {},
    create: { userId, roleId: role.id }
  });
}

async function assertSubscriptionActiveForUser(userId, role) {
  if (!isPaidRole(role)) return { ok: true };
  if (role === Role.VENDOR) {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) return { ok: false, reason: 'vendor_profile_required' };
    const active = vendor.subscriptionExpiry && vendor.subscriptionExpiry.getTime() > Date.now();
    if (!active) return { ok: false, reason: 'subscription_required' };
    return { ok: true, vendor };
  }
  const active = await prisma.vendorSubscriptionInvoice.findFirst({
    where: {
      vendor: { userId },
      endsAt: { gt: new Date() },
      status: PaymentStatus.SUCCESS
    }
  });
  return active ? { ok: true } : { ok: false, reason: 'subscription_required' };
}

async function trackLeadEvent({ leadId, vendorId, eventType, metadata }) {
  if (!leadId || !eventType) return;
  await prisma.leadEvent.create({
    data: {
      leadId,
      vendorId,
      eventType,
      metadata: metadata || {}
    }
  });

  if (queues) {
    await queues.analytics.add('lead_event', {
      category: metadata?.category || 'GENERAL',
      searches: eventType === LeadEventType.SEARCH ? 1 : 0,
      chatsStarted: eventType === LeadEventType.CHAT_STARTED ? 1 : 0,
      leadsQualified: eventType === LeadEventType.ORDER_INTENT ? 1 : 0
    }, { attempts: 3, backoff: { type: 'fixed', delay: 2000 } });
  }
}

app.get('/health', async (_req, res) => {
  const redisHealth = redis ? await redis.ping().then(() => 'ok').catch(() => 'error') : 'disabled';
  return res.json({ ok: true, service: 'railway-backend', redis: redisHealth, time: new Date().toISOString() });
});

app.get('/services/active', auth, async (_req, res) => {
  const services = await prisma.service.findMany({
    where: { isActive: true },
    select: { id: true, name: true, handlerKey: true, launchStage: true },
    orderBy: { name: 'asc' }
  });
  return res.json({ services });
});

app.post('/auth/send-otp', async (req, res) => {
  const { phone, channel = 'WHATSAPP' } = req.body || {};
  if (!phone) return jsonError(res, 400, 'phone required');

  const normalizedPhone = normalizePhone(phone, detectCountryCode(req));
  if (normalizedPhone.length < 10) return jsonError(res, 400, 'invalid_phone');

  const otp = String(process.env.DEV_OTP || Math.floor(100000 + Math.random() * 900000));
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  let user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        phone: normalizedPhone,
        role: Role.CUSTOMER,
        name: 'New User',
        countryCode: normalizedPhone.match(/^\+\d{1,3}/)?.[0] || detectCountryCode(req)
      }
    });
  }

  await prisma.otpVerification.create({
    data: {
      userId: user.id,
      phone: normalizedPhone,
      otpHash,
      expiresAt,
      channel,
      provider: process.env.WHATSAPP_API_URL ? 'WHATSAPP_API' : 'DEV',
      metadata: { fallbackChannels: ['SMS', 'EMAIL'] }
    }
  });

  return res.json({
    ok: true,
    phone: normalizedPhone,
    expiresAt: expiresAt.toISOString(),
    delivery: process.env.WHATSAPP_API_URL ? 'whatsapp_api' : 'fallback_simulated',
    ...(process.env.DEV_OTP ? { otp } : {})
  });
});

app.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp, deviceId } = req.body || {};
  if (!phone || !otp) return jsonError(res, 400, 'phone and otp required');
  const normalizedPhone = normalizePhone(phone, detectCountryCode(req));

  const otpRow = await prisma.otpVerification.findFirst({
    where: {
      phone: normalizedPhone,
      consumedAt: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!otpRow) return jsonError(res, 401, 'otp_expired');
  if (hashOtp(String(otp)) !== otpRow.otpHash) return jsonError(res, 401, 'invalid_otp');

  await prisma.otpVerification.update({ where: { id: otpRow.id }, data: { consumedAt: new Date() } });

  let user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (!user) user = await prisma.user.create({ data: { phone: normalizedPhone, role: Role.CUSTOMER, name: 'New User' } });
  await syncUserRole(user.id, user.role);

  const jwtId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const session = await prisma.userSession.create({
    data: {
      userId: user.id,
      deviceId: String(deviceId || req.headers['x-device-id'] || 'unknown-device'),
      jwtId,
      expiresAt,
      ipAddress: String(req.headers['x-forwarded-for'] || req.ip || ''),
      userAgent: String(req.headers['user-agent'] || '')
    }
  });

  const token = jwt.sign(
    { sub: user.id, role: user.role, phone: user.phone, onboardingStatus: user.onboardingStatus, jti: jwtId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  return res.json({ token, user, sessionId: session.id, expiresAt: expiresAt.toISOString() });
});

app.post('/user/register', auth, async (req, res) => {
  const { name, role, lastLocation } = req.body || {};
  const roleMap = {
    CUSTOMER: Role.CUSTOMER,
    DRIVER: Role.DRIVER,
    VENDOR: Role.VENDOR,
    SERVICE_PROVIDER: Role.SERVICE_AGENT,
    SERVICE_AGENT: Role.SERVICE_AGENT,
    SUPER_ADMIN: Role.ADMIN,
    ADMIN: Role.ADMIN
  };
  const validRole = roleMap[String(role || '').toUpperCase()] || req.user.role;
  const needsApproval = [Role.VENDOR, Role.DRIVER, Role.SERVICE_AGENT].includes(validRole);

  const user = await prisma.user.update({
    where: { id: req.user.sub },
    data: {
      name: name || undefined,
      role: validRole,
      onboardingStatus: needsApproval ? OnboardingStatus.PENDING : OnboardingStatus.APPROVED,
      lastLatitude: lastLocation?.lat,
      lastLongitude: lastLocation?.lng
    }
  });

  if (needsApproval) {
    await prisma.adminApproval.create({
      data: {
        userId: user.id,
        requestedRole: validRole,
        status: ApprovalStatus.PENDING
      }
    });
  }

  await syncUserRole(user.id, validRole);

  return res.json({ user, requiresApproval: needsApproval });
});

app.get('/auth/me', auth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    include: {
      userRoles: { include: { role: true } },
      driver: true,
      vendor: true
    }
  });
  if (!user) return jsonError(res, 404, 'user_not_found');
  return res.json({
    user,
    uiCapabilities: {
      canAccessDriverView: Boolean(user.driver || user.userRoles.some((r) => r.role.name === 'driver')),
      canAccessVendorView: Boolean(user.vendor || user.userRoles.some((r) => r.role.name === 'vendor')),
      isAdmin: user.userRoles.some((r) => r.role.name === 'admin') || user.role === Role.ADMIN
    }
  });
});

app.post('/onboarding/:type', auth, async (req, res) => {
  const type = String(req.params.type || '').toUpperCase();
  if (!Object.values(OnboardingType).includes(type)) return jsonError(res, 400, 'invalid onboarding type');

  const appRow = await prisma.onboardingApplication.create({
    data: {
      applicantId: req.user.sub,
      type,
      status: OnboardingStatus.PENDING,
      details: req.body || {}
    }
  });

  return res.status(201).json({ application: appRow });
});

app.post('/chat/intent', auth, rateLimit, async (req, res) => {
  const { message, lat, lng } = req.body || {};
  const intent = intentFromMessage(message);
  const customer = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const sourceLat = Number.isFinite(Number(lat)) ? Number(lat) : customer?.lastLatitude;
  const sourceLng = Number.isFinite(Number(lng)) ? Number(lng) : customer?.lastLongitude;
  if (!Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) {
    return res.json({ intent: intent.intent, quickReplies: ['Share location'], results: [] });
  }

  const box = boundingBox(sourceLat, sourceLng, 8);
  const rows = await prisma.vendor.findMany({
    where: {
      status: VendorStatus.ACTIVE,
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLng, lte: box.maxLng }
    },
    include: { user: { select: { name: true, phone: true } } },
    take: 10
  });
  const results = rows.map((v) => ({
    id: v.id,
    kind: 'vendor',
    name: v.user?.name || 'Vendor',
    distanceKm: distanceKm(sourceLat, sourceLng, v.latitude, v.longitude),
    whatsappLink: `https://wa.me/${(v.user?.phone || '').replace(/[^\d]/g, '')}?text=${encodeURIComponent(`Vyntaro lead: ${message || ''}`)}`,
    fallback: { type: 'in_app_chat', endpoint: '/chat/initiate' }
  })).sort((a, b) => a.distanceKm - b.distanceKm);

  return res.json({ intent: intent.intent, quickReplies: ['Show more nearby', 'Open WhatsApp chat'], results: results.slice(0, 5) });
});

app.post('/chat/message', auth, rateLimit, async (req, res) => {
  const { message, lat, lng } = req.body || {};
  const routed = await routeChatMessage({ prisma, userId: req.user.sub, message });
  const customer = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const sourceLat = Number.isFinite(Number(lat)) ? Number(lat) : customer?.lastLatitude;
  const sourceLng = Number.isFinite(Number(lng)) ? Number(lng) : customer?.lastLongitude;
  const nearby = await discoverNearbyByModule({
    prisma,
    module: routed.module,
    sourceLat,
    sourceLng,
    maxResults: 5
  });

  const quickReplies = routed.quickReplies?.length
    ? routed.quickReplies
    : routed.serviceMenu?.length
      ? routed.serviceMenu.map((service) => service.name)
      : ['menu'];

  if (routed.module) {
    await prisma.lead.create({
      data: {
        customerId: req.user.sub,
        intent: chatModuleToIntent(routed.module),
        query: String(message || ''),
        status: nearby.length ? LeadStatus.QUALIFIED : LeadStatus.OPEN,
        metadata: {
          source: 'chat_message',
          module: routed.module,
          hasLocation: Boolean(Number.isFinite(sourceLat) && Number.isFinite(sourceLng)),
          matchedCount: nearby.length
        }
      }
    }).catch(() => {});
  }

  const response = {
    intent: routed.module || routed.service?.name || 'SERVICE_SELECTION',
    quickReplies,
    results: nearby,
    reply: routed.reply,
    session: routed.session
  };
  return res.json(response);
});

app.get('/vendors/nearby', auth, allow(Role.CUSTOMER), rateLimit, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const category = req.query.category;
  const q = String(req.query.q || '').toLowerCase();
  const maxKm = Number(req.query.maxKm || 5);
  const { page, pageSize, skip } = parsePagination(req.query);

  const customer = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const sourceLat = Number.isFinite(lat) ? lat : customer?.lastLatitude;
  const sourceLng = Number.isFinite(lng) ? lng : customer?.lastLongitude;
  if (!Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) return jsonError(res, 400, 'location required');

  const cacheKey = `nearby:vendors:${sourceLat.toFixed(4)}:${sourceLng.toFixed(4)}:${category || 'all'}:${q}:${maxKm}:${page}:${pageSize}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cache: 'hit' });

  const box = boundingBox(sourceLat, sourceLng, maxKm);

  const whereClause = {
    status: VendorStatus.ACTIVE,
    latitude: { gte: box.minLat, lte: box.maxLat },
    longitude: { gte: box.minLng, lte: box.maxLng },
    ...(category && Object.values(VendorCategory).includes(category) ? { category } : {}),
    ...(q
      ? {
          OR: [
            { user: { name: { contains: q, mode: Prisma.QueryMode.insensitive } } },
            { category: { equals: category || undefined } }
          ]
        }
      : {})
  };

  const [rows, total] = await Promise.all([
    prisma.vendor.findMany({
      where: whereClause,
      include: {
        user: { select: { id: true, name: true } },
        promotions: {
          where: { isActive: true, startsAt: { lte: new Date() }, endsAt: { gte: new Date() } },
          orderBy: { boostPoints: 'desc' },
          take: 1
        }
      },
      take: pageSize * 4,
      skip
    }),
    prisma.vendor.count({ where: whereClause })
  ]);

  const ranked = rows
    .map((v) => {
      const km = distanceKm(sourceLat, sourceLng, v.latitude, v.longitude);
      return buildVendorScore({
        id: v.id,
        name: v.user?.name || v.category,
        category: v.category,
        distanceKm: km,
        rating: v.rating,
        avgResponseSeconds: v.avgResponseSeconds,
        subscriptionType: v.subscriptionType,
        priorityScore: v.priorityScore,
        paidBoost: v.paidBoost,
        activePromotionBoost: v.promotions[0]?.boostPoints || 0
      });
    })
    .filter((v) => v.distanceKm <= maxKm)
    .sort((a, b) =>
      a.distanceKm - b.distanceKm
      || (SUBSCRIPTION_RANK_BOOST[b.subscriptionType] || 0) - (SUBSCRIPTION_RANK_BOOST[a.subscriptionType] || 0)
      || b.rating - a.rating
      || b.score - a.score
    )
    .slice(0, pageSize);

  const response = { page, pageSize, total, vendors: ranked, cache: 'miss' };
  await cacheSet(cacheKey, response, 60);

  if (queues) {
    await queues.analytics.add('search_category', {
      category: category || 'ALL',
      searches: 1
    }, { attempts: 3, removeOnComplete: 1000, backoff: { type: 'fixed', delay: 1500 } });
  }

  return res.json(response);
});

app.post('/chat/wa-link', auth, async (req, res) => {
  const { phone, query, location } = req.body || {};
  const targetPhone = normalizePhone(phone, detectCountryCode(req));
  if (!targetPhone) return jsonError(res, 400, 'phone_required');
  const brand = 'Vyntaro';
  const message = `${brand} lead\nQuery: ${String(query || 'Hello')}\nLocation: ${location?.lat ?? 'NA'},${location?.lng ?? 'NA'}`;
  const waPhone = targetPhone.replace(/[^\d]/g, '');
  return res.json({
    waLink: `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`,
    fallback: {
      type: 'IN_APP_CHAT',
      initiateEndpoint: '/chat/initiate'
    }
  });
});

app.post('/chat/initiate', auth, async (req, res) => {
  const { vendorId, driverId } = req.body || {};
  if (!vendorId && !driverId) return jsonError(res, 400, 'vendorId or driverId required');

  const room = await prisma.chatRoom.upsert({
    where: {
      id: `${req.user.sub}:${vendorId || ''}:${driverId || ''}`
    },
    update: { updatedAt: new Date() },
    create: {
      id: `${req.user.sub}:${vendorId || ''}:${driverId || ''}`,
      customerId: req.user.sub,
      vendorId: vendorId || null,
      driverId: driverId || null
    }
  }).catch(async () => {
    const existing = await prisma.chatRoom.findFirst({
      where: {
        customerId: req.user.sub,
        vendorId: vendorId || null,
        driverId: driverId || null
      },
      orderBy: { updatedAt: 'desc' }
    });
    if (existing) return existing;
    return prisma.chatRoom.create({
      data: {
        customerId: req.user.sub,
        vendorId: vendorId || null,
        driverId: driverId || null
      }
    });
  });

  return res.status(201).json({ chatRoom: room });
});

app.post('/chat/save-message', auth, async (req, res) => {
  const { chatRoomId, message } = req.body || {};
  if (!chatRoomId || !message) return jsonError(res, 400, 'chatRoomId and message required');

  const room = await prisma.chatRoom.findUnique({ where: { id: chatRoomId } });
  if (!room || room.customerId !== req.user.sub) return jsonError(res, 403, 'forbidden');

  const saved = await prisma.message.create({
    data: { chatRoomId, senderId: req.user.sub, message: String(message) }
  });
  return res.status(201).json({ message: saved });
});

app.post('/vendors/:id/boost', auth, allow(Role.VENDOR, Role.ADMIN), rateLimit, async (req, res) => {
  const vendorId = req.params.id;
  const { boostPoints = 15, amount, currency = 'INR', startsAt, endsAt } = req.body || {};

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return jsonError(res, 404, 'vendor_not_found');
  if (req.user.role === Role.VENDOR && vendor.userId !== req.user.sub) return jsonError(res, 403, 'forbidden');
  if (req.user.role === Role.VENDOR) {
    const subCheck = await assertSubscriptionActiveForUser(req.user.sub, Role.VENDOR);
    if (!subCheck.ok) return jsonError(res, 402, subCheck.reason);
  }

  const payment = await prisma.paymentTransaction.create({
    data: {
      vendorId,
      amount: Number(amount || Math.max(99, boostPoints * 10)),
      currency,
      provider: 'RAZORPAY',
      providerRef: `mock_boost_${Date.now()}`,
      status: PaymentStatus.SUCCESS,
      metadata: { feature: 'boost_listing', boostPoints }
    }
  });

  const promotion = await prisma.vendorPromotion.create({
    data: {
      vendorId,
      boostPoints: Number(boostPoints),
      startsAt: startsAt ? new Date(startsAt) : new Date(),
      endsAt: endsAt ? new Date(endsAt) : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      isActive: true,
      paymentTxnId: payment.id
    }
  });

  return res.status(201).json({ promotion, payment });
});

app.post('/vendors/:id/subscription', auth, allow(Role.VENDOR, Role.ADMIN), async (req, res) => {
  const vendorId = req.params.id;
  const { subscriptionType = SubscriptionType.BASIC, months = 1, amount, provider = 'RAZORPAY', planType = 'monthly' } = req.body || {};

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return jsonError(res, 404, 'vendor_not_found');
  if (req.user.role === Role.VENDOR && vendor.userId !== req.user.sub) return jsonError(res, 403, 'forbidden');
  if (!Object.values(SubscriptionType).includes(subscriptionType)) return jsonError(res, 400, 'invalid_subscription_type');

  const plan = planPrice(String(planType).toLowerCase() === 'yearly' ? 'yearly' : 'monthly');
  const durationMonths = Math.max(1, Number(months || plan.months));
  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + durationMonths);

  const txn = await prisma.paymentTransaction.create({
    data: {
      vendorId,
      amount: Number(amount || plan.amount),
      currency: 'INR',
      provider,
      providerRef: `mock_sub_${Date.now()}`,
      status: PaymentStatus.SUCCESS,
      metadata: { feature: 'subscription', subscriptionType, months: durationMonths, planType, launchOfferApplied: plan.launchOfferApplied }
    }
  });

  const invoice = await prisma.vendorSubscriptionInvoice.create({
    data: {
      vendorId,
      subscriptionType,
      startsAt: new Date(),
      endsAt: expiry,
      amount: txn.amount,
      paymentTxnId: txn.id,
      status: PaymentStatus.SUCCESS
    }
  });

  const updatedVendor = await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      subscriptionType,
      subscriptionExpiry: expiry,
      priorityScore: subscriptionType === SubscriptionType.PREMIUM ? 20 : 8
    }
  });

  return res.json({ vendor: updatedVendor, invoice, payment: txn, pricing: { amountInr: txn.amount, launchOfferApplied: plan.launchOfferApplied } });
});

app.post('/leads/:id/events', auth, async (req, res) => {
  const leadId = req.params.id;
  const { eventType, vendorId, metadata } = req.body || {};
  if (!Object.values(LeadEventType).includes(eventType)) return jsonError(res, 400, 'invalid_event_type');

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return jsonError(res, 404, 'lead_not_found');

  await trackLeadEvent({ leadId, vendorId, eventType, metadata });

  if (vendorId && [LeadEventType.CHAT_STARTED, LeadEventType.ORDER_INTENT].includes(eventType)) {
    const charge = eventType === LeadEventType.ORDER_INTENT ? 20 : 10;
    await prisma.vendorWallet.upsert({
      where: { vendorId },
      update: { balance: { decrement: charge }, totalDebited: { increment: charge } },
      create: { vendorId, balance: -charge, totalDebited: charge }
    });
    await prisma.walletLedger.create({
      data: {
        vendorId,
        amount: charge,
        type: 'DEBIT',
        reason: `lead_${eventType.toLowerCase()}`,
        referenceId: leadId
      }
    });
  }

  return res.status(201).json({ ok: true });
});

app.post('/order/create', auth, allow(Role.CUSTOMER), rateLimit, async (req, res) => {
  const { type, vendorId, driverId, serviceAgentId, leadId, metadata } = req.body || {};
  if (!type || !Object.values(OrderType).includes(type)) return jsonError(res, 400, 'valid type required');

  const order = await prisma.orderRide.create({
    data: {
      type,
      status: OrderStatus.PENDING,
      customerId: req.user.sub,
      vendorId,
      driverId,
      serviceAgentId,
      leadId,
      metadata
    }
  });

  if (leadId) {
    await prisma.lead.update({ where: { id: leadId }, data: { status: LeadStatus.CONVERTED } }).catch(() => {});
    await trackLeadEvent({ leadId, vendorId, eventType: LeadEventType.ORDER_INTENT, metadata: { from: 'order_create' } });
  }

  if (queues) {
    await queues.orders.add('process_order', { orderId: order.id }, { attempts: 5, backoff: { type: 'fixed', delay: 2000 } });
    await queues.notifications.add('order_created', { orderId: order.id, customerId: req.user.sub }, { attempts: 3, backoff: { type: 'fixed', delay: 1000 } });
  }

  return res.status(201).json({ order });
});

app.post('/admin/auth/send-otp', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !String(email).includes('@')) return jsonError(res, 400, 'valid email required');
  const otp = String(process.env.DEV_OTP || Math.floor(100000 + Math.random() * 900000));
  const otpHash = hashOtp(otp);
  await prisma.otpVerification.create({
    data: {
      phone: `email:${String(email).toLowerCase()}`,
      otpHash,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      channel: 'EMAIL',
      purpose: 'ADMIN_LOGIN'
    }
  });
  return res.json({ ok: true, resendInSec: 30, ...(process.env.DEV_OTP ? { otp } : {}) });
});

app.post('/admin/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) return jsonError(res, 400, 'email and otp required');
  const marker = `email:${String(email).toLowerCase()}`;
  const row = await prisma.otpVerification.findFirst({
    where: { phone: marker, consumedAt: null, purpose: 'ADMIN_LOGIN', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  });
  if (!row || row.otpHash !== hashOtp(otp)) return jsonError(res, 401, 'invalid_otp');
  await prisma.otpVerification.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
  const token = jwt.sign({ sub: `admin:${email}`, role: Role.ADMIN, email }, process.env.JWT_SECRET, { expiresIn: '1d' });
  return res.json({ token });
});

app.get('/admin/approvals', auth, allow(Role.ADMIN), async (req, res) => {
  const rows = await prisma.adminApproval.findMany({
    where: { status: ApprovalStatus.PENDING },
    include: { applicant: { select: { id: true, name: true, phone: true, role: true } } },
    orderBy: { createdAt: 'asc' }
  });
  return res.json({ approvals: rows });
});

app.post('/admin/approvals/:id', auth, allow(Role.ADMIN), async (req, res) => {
  const { decision, notes } = req.body || {};
  const status = String(decision).toUpperCase() === 'APPROVE' ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
  const approval = await prisma.adminApproval.update({
    where: { id: req.params.id },
    data: { status, notes, reviewedById: req.user.sub, reviewedAt: new Date() }
  });
  await prisma.user.update({
    where: { id: approval.userId },
    data: { onboardingStatus: status === ApprovalStatus.APPROVED ? OnboardingStatus.APPROVED : OnboardingStatus.REJECTED }
  });
  return res.json({ approval });
});

app.get('/analytics/summary', auth, allow(Role.ADMIN), async (req, res) => {
  const { page, pageSize, skip } = parsePagination(req.query);
  const metrics = await prisma.analyticsMetric.findMany({
    orderBy: { createdAt: 'desc' },
    take: pageSize,
    skip
  });

  const revenue = await prisma.paymentTransaction.aggregate({
    where: { status: PaymentStatus.SUCCESS },
    _sum: { amount: true }
  });

  return res.json({
    page,
    pageSize,
    metrics,
    revenue: revenue._sum.amount || 0
  });
});

app.get('/admin/users', auth, allow(Role.ADMIN), async (req, res) => {
  const { page, pageSize, skip } = parsePagination(req.query);
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip,
      select: {
        id: true,
        name: true,
        phone: true,
        role: true,
        onboardingStatus: true,
        createdAt: true
      }
    }),
    prisma.user.count()
  ]);
  return res.json({ page, pageSize, total, users });
});

app.get('/admin/services', auth, allow(Role.ADMIN), async (_req, res) => {
  const services = await prisma.service.findMany({ orderBy: { createdAt: 'asc' } });
  return res.json({ services });
});

app.post('/admin/services/:id/toggle', auth, allow(Role.ADMIN), async (req, res) => {
  const id = req.params.id;
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) return jsonError(res, 404, 'service_not_found');
  const updated = await prisma.service.update({ where: { id }, data: { isActive: !service.isActive } });
  return res.json({ service: updated });
});

app.get('/admin/chat/activity', auth, allow(Role.ADMIN), async (_req, res) => {
  const [sessions, recentMessages] = await Promise.all([
    prisma.chatSession.findMany({
      take: 50,
      orderBy: { updatedAt: 'desc' },
      include: { user: { select: { id: true, phone: true, role: true } }, currentService: true }
    }),
    prisma.chatMessage.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, phone: true } }, service: true }
    })
  ]);
  return res.json({ sessions, recentMessages });
});

app.use((err, _req, res, _next) => {
  console.error('backend_error', err);
  return jsonError(res, 500, 'internal_error');
});

const port = Number(process.env.PORT || 3001);
const server = http.createServer(app);
attachChatWebSocketServer({
  server,
  prisma,
  jwtSecret: process.env.JWT_SECRET,
  redis
});

async function boot() {
  try {
    await ensureCoreAuthSchema();
  } catch (error) {
    console.error('schema_bootstrap_failed', error);
  }

  server.listen(port, () => {
    console.log(`backend listening on ${port}`);
    console.log(`redis enabled: ${redisEnabled}`);
  });
}

boot();
