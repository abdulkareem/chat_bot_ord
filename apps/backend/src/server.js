import express from 'express';
import jwt from 'jsonwebtoken';
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
  LeadEventType
} from '@prisma/client';

const app = express();
const prisma = new PrismaClient();
app.use(express.json({ limit: '1mb' }));

const inMemoryCache = new Map();
const inMemoryRateLimit = new Map();

const AUTH_ROLES = {
  CUSTOMER: Role.CUSTOMER,
  VENDOR: Role.VENDOR,
  DRIVER: Role.DRIVER,
  SERVICE_AGENT: Role.SERVICE_AGENT,
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

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return jsonError(res, 401, 'missing token');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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

app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return jsonError(res, 400, 'phone required');
  return res.json({ ok: true, otp: process.env.DEV_OTP || '123456' });
});

app.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) return jsonError(res, 400, 'phone and otp required');
  if ((process.env.DEV_OTP || '123456') !== String(otp)) return jsonError(res, 401, 'invalid otp');

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) user = await prisma.user.create({ data: { phone, role: Role.CUSTOMER, name: 'New User' } });
  const token = jwt.sign({ sub: user.id, role: user.role, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return res.json({ token, user });
});

app.post('/user/register', auth, async (req, res) => {
  const { name, role, lastLocation } = req.body || {};
  const validRole = Object.values(Role).includes(role) ? role : req.user.role;

  const user = await prisma.user.update({
    where: { id: req.user.sub },
    data: {
      name: name || undefined,
      role: validRole,
      lastLatitude: lastLocation?.lat,
      lastLongitude: lastLocation?.lng
    }
  });

  return res.json({ user });
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
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
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

app.post('/vendors/:id/boost', auth, allow(Role.VENDOR, Role.ADMIN), rateLimit, async (req, res) => {
  const vendorId = req.params.id;
  const { boostPoints = 15, amount, currency = 'INR', startsAt, endsAt } = req.body || {};

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return jsonError(res, 404, 'vendor_not_found');
  if (req.user.role === Role.VENDOR && vendor.userId !== req.user.sub) return jsonError(res, 403, 'forbidden');

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
  const { subscriptionType = SubscriptionType.BASIC, months = 1, amount, provider = 'RAZORPAY' } = req.body || {};

  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) return jsonError(res, 404, 'vendor_not_found');
  if (req.user.role === Role.VENDOR && vendor.userId !== req.user.sub) return jsonError(res, 403, 'forbidden');
  if (!Object.values(SubscriptionType).includes(subscriptionType)) return jsonError(res, 400, 'invalid_subscription_type');

  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + Math.max(1, Number(months)));

  const txn = await prisma.paymentTransaction.create({
    data: {
      vendorId,
      amount: Number(amount || (subscriptionType === SubscriptionType.PREMIUM ? 1999 : 799)),
      currency: 'INR',
      provider,
      providerRef: `mock_sub_${Date.now()}`,
      status: PaymentStatus.SUCCESS,
      metadata: { feature: 'subscription', subscriptionType, months }
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

  return res.json({ vendor: updatedVendor, invoice, payment: txn });
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

app.use((err, _req, res, _next) => {
  console.error('backend_error', err);
  return jsonError(res, 500, 'internal_error');
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`backend listening on ${port}`);
  console.log(`redis enabled: ${redisEnabled}`);
});
