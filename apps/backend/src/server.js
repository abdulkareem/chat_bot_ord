import express from 'express';
import jwt from 'jsonwebtoken';
import {
  PrismaClient,
  Role,
  VendorCategory,
  VehicleType,
  OrderType,
  OrderStatus,
  OnboardingType,
  OnboardingStatus,
  LeadIntent,
  LeadStatus
} from '@prisma/client';

const app = express();
const prisma = new PrismaClient();
app.use(express.json({ limit: '1mb' }));

const SEARCH_CACHE = new Map();

const AUTH_ROLES = {
  CUSTOMER: Role.CUSTOMER,
  VENDOR: Role.VENDOR,
  DRIVER: Role.DRIVER,
  SERVICE_AGENT: Role.SERVICE_AGENT,
  ADMIN: Role.ADMIN
};

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

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = (bLat - aLat) * (Math.PI / 180);
  const dLng = (bLng - aLng) * (Math.PI / 180);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
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

function withCache(key, ttlMs, compute) {
  const now = Date.now();
  const hit = SEARCH_CACHE.get(key);
  if (hit && hit.expiresAt > now) return Promise.resolve(hit.value);
  return Promise.resolve(compute()).then((value) => {
    SEARCH_CACHE.set(key, { value, expiresAt: now + ttlMs });
    return value;
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'railway-backend', time: new Date().toISOString() }));

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

app.get('/onboarding/my', auth, async (req, res) => {
  const rows = await prisma.onboardingApplication.findMany({
    where: { applicantId: req.user.sub },
    orderBy: { createdAt: 'desc' }
  });
  return res.json({ applications: rows });
});

app.get('/admin/onboarding', auth, allow(Role.ADMIN), async (req, res) => {
  const { page, pageSize, skip } = parsePagination(req.query);
  const status = req.query.status?.toUpperCase();
  const rows = await prisma.onboardingApplication.findMany({
    where: Object.values(OnboardingStatus).includes(status) ? { status } : undefined,
    include: { applicant: { select: { id: true, phone: true, name: true, role: true } } },
    orderBy: { createdAt: 'desc' },
    skip,
    take: pageSize
  });
  return res.json({ page, pageSize, items: rows });
});

app.post('/admin/onboarding/:id/review', auth, allow(Role.ADMIN), async (req, res) => {
  const { status, reviewNotes } = req.body || {};
  if (![OnboardingStatus.APPROVED, OnboardingStatus.REJECTED].includes(status)) return jsonError(res, 400, 'invalid status');

  const application = await prisma.onboardingApplication.update({
    where: { id: req.params.id },
    data: { status, reviewedBy: req.user.sub, reviewNotes: reviewNotes || null },
    include: { applicant: true }
  });

  if (status === OnboardingStatus.APPROVED) {
    if (application.type === OnboardingType.VENDOR) {
      await prisma.user.update({ where: { id: application.applicantId }, data: { role: Role.VENDOR } });
      await prisma.vendor.upsert({
        where: { userId: application.applicantId },
        create: {
          userId: application.applicantId,
          category: application.details?.category || VendorCategory.GROCERY,
          rating: Number(application.details?.rating || 0),
          isPaid: Boolean(application.details?.isPaid),
          paidBoost: Number(application.details?.paidBoost || 0)
        },
        update: {
          category: application.details?.category || undefined,
          isPaid: Boolean(application.details?.isPaid),
          paidBoost: Number(application.details?.paidBoost || 0)
        }
      });
    }

    if (application.type === OnboardingType.DRIVER) {
      await prisma.user.update({ where: { id: application.applicantId }, data: { role: Role.DRIVER } });
      await prisma.driver.upsert({
        where: { userId: application.applicantId },
        create: {
          userId: application.applicantId,
          vehicleType: application.details?.vehicleType || VehicleType.AUTO,
          isAvailable: true
        },
        update: {
          vehicleType: application.details?.vehicleType || undefined,
          isAvailable: true
        }
      });
    }

    if (application.type === OnboardingType.SERVICE) {
      await prisma.user.update({ where: { id: application.applicantId }, data: { role: Role.SERVICE_AGENT } });
      await prisma.serviceAgent.upsert({
        where: { userId: application.applicantId },
        create: {
          userId: application.applicantId,
          serviceType: application.details?.serviceType || 'general',
          isAvailable: true
        },
        update: {
          serviceType: application.details?.serviceType || undefined,
          isAvailable: true
        }
      });
    }
  }

  return res.json({ application });
});

app.get('/vendors/nearby', auth, allow(Role.CUSTOMER), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const category = req.query.category;
  const q = String(req.query.q || '').toLowerCase();
  const maxKm = Number(req.query.maxKm || 3);
  const sortBy = String(req.query.sortBy || 'priority');

  const customer = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const sourceLat = Number.isFinite(lat) ? lat : customer?.lastLatitude;
  const sourceLng = Number.isFinite(lng) ? lng : customer?.lastLongitude;
  if (!Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) return jsonError(res, 400, 'location required');

  const cacheKey = `vendor:${sourceLat}:${sourceLng}:${category}:${q}:${maxKm}:${sortBy}`;
  const ranked = await withCache(cacheKey, 15_000, async () => {
    const interactedVendorIds = (await prisma.chatRoom.findMany({ where: { customerId: req.user.sub, vendorId: { not: null } }, select: { vendorId: true } }))
      .map((r) => r.vendorId)
      .filter(Boolean);

    const vendors = await prisma.vendor.findMany({
      where: {
        ...(category && Object.values(VendorCategory).includes(category) ? { category } : {}),
        user: { lastLatitude: { not: null }, lastLongitude: { not: null } }
      },
      include: { user: true }
    });

    return vendors
      .filter((v) => !q || String(v.user.name || '').toLowerCase().includes(q) || String(v.category).toLowerCase().includes(q))
      .map((v) => ({
        ...v,
        distanceKm: distanceKm(sourceLat, sourceLng, v.user.lastLatitude, v.user.lastLongitude),
        previouslyInteracted: interactedVendorIds.includes(v.id)
      }))
      .filter((v) => v.distanceKm <= maxKm)
      .sort((a, b) => {
        if (sortBy === 'distance') return a.distanceKm - b.distanceKm;
        if (sortBy === 'rating') return b.rating - a.rating || a.distanceKm - b.distanceKm;
        return (Number(b.isPaid) - Number(a.isPaid)) || (b.paidBoost - a.paidBoost) || Number(b.previouslyInteracted) - Number(a.previouslyInteracted) || b.rating - a.rating || a.distanceKm - b.distanceKm;
      });
  });

  return res.json({ vendors: ranked });
});

app.get('/drivers/nearby', auth, allow(Role.CUSTOMER), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const vehicleType = req.query.type;
  const maxKm = Number(req.query.maxKm || 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return jsonError(res, 400, 'lat/lng required');

  const drivers = await prisma.driver.findMany({
    where: {
      isAvailable: true,
      ...(vehicleType && Object.values(VehicleType).includes(vehicleType) ? { vehicleType } : {}),
      user: { lastLatitude: { not: null }, lastLongitude: { not: null } }
    },
    include: { user: true }
  });

  const nearby = drivers
    .map((d) => ({ ...d, distanceKm: distanceKm(lat, lng, d.user.lastLatitude, d.user.lastLongitude) }))
    .filter((d) => d.distanceKm <= maxKm)
    .sort((a, b) => b.rating - a.rating || a.distanceKm - b.distanceKm);

  return res.json({ drivers: nearby });
});

app.get('/services/nearby', auth, allow(Role.CUSTOMER), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const type = String(req.query.type || '').toLowerCase();
  const maxKm = Number(req.query.maxKm || 3);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return jsonError(res, 400, 'lat/lng required');

  const agents = await prisma.serviceAgent.findMany({
    where: {
      isAvailable: true,
      ...(type ? { serviceType: { contains: type, mode: 'insensitive' } } : {}),
      user: { lastLatitude: { not: null }, lastLongitude: { not: null } }
    },
    include: { user: true }
  });

  const nearby = agents
    .map((a) => ({ ...a, distanceKm: distanceKm(lat, lng, a.user.lastLatitude, a.user.lastLongitude) }))
    .filter((a) => a.distanceKm <= maxKm)
    .sort((a, b) => b.rating - a.rating || a.distanceKm - b.distanceKm);

  return res.json({ services: nearby });
});

app.post('/chat/intent', auth, allow(Role.CUSTOMER), async (req, res) => {
  const { message, lat, lng } = req.body || {};
  if (!message) return jsonError(res, 400, 'message required');

  const detected = intentFromMessage(message);
  const customer = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const sourceLat = Number.isFinite(Number(lat)) ? Number(lat) : customer?.lastLatitude;
  const sourceLng = Number.isFinite(Number(lng)) ? Number(lng) : customer?.lastLongitude;

  let results = [];
  if (Number.isFinite(sourceLat) && Number.isFinite(sourceLng)) {
    if (detected.intent === LeadIntent.SHOPPING) {
      const vendors = await prisma.vendor.findMany({ include: { user: true }, take: 10 });
      results = vendors
        .map((v) => ({
          id: v.id,
          kind: 'vendor',
          name: v.user.name || v.category,
          distanceKm: distanceKm(sourceLat, sourceLng, v.user.lastLatitude || sourceLat, v.user.lastLongitude || sourceLng),
          score: (v.isPaid ? 50 : 0) + v.paidBoost + v.rating
        }))
        .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
        .slice(0, 5);
    }

    if (detected.intent === LeadIntent.AUTO) {
      const drivers = await prisma.driver.findMany({ where: { isAvailable: true }, include: { user: true }, take: 10 });
      results = drivers
        .map((d) => ({
          id: d.id,
          kind: 'driver',
          name: d.user.name || d.vehicleType,
          distanceKm: distanceKm(sourceLat, sourceLng, d.user.lastLatitude || sourceLat, d.user.lastLongitude || sourceLng),
          score: d.rating
        }))
        .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
        .slice(0, 5);
    }

    if (detected.intent === LeadIntent.SERVICE) {
      const services = await prisma.serviceAgent.findMany({ where: { isAvailable: true }, include: { user: true }, take: 10 });
      results = services
        .map((s) => ({
          id: s.id,
          kind: 'service',
          name: s.user.name || s.serviceType,
          distanceKm: distanceKm(sourceLat, sourceLng, s.user.lastLatitude || sourceLat, s.user.lastLongitude || sourceLng),
          score: s.rating
        }))
        .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
        .slice(0, 5);
    }
  }

  const lead = await prisma.lead.create({
    data: {
      customerId: req.user.sub,
      intent: detected.intent,
      query: detected.keyword || String(message),
      status: LeadStatus.OPEN,
      metadata: { sourceLat, sourceLng, resultCount: results.length }
    }
  });

  return res.json({
    intent: detected.intent,
    keyword: detected.keyword,
    leadId: lead.id,
    quickReplies: detected.intent === LeadIntent.SHOPPING
      ? ['Connect vendor', 'Place order', 'Show more nearby']
      : detected.intent === LeadIntent.AUTO
      ? ['Book ride', 'Connect driver', 'Show closer options']
      : detected.intent === LeadIntent.SERVICE
      ? ['Connect service agent', 'Book now', 'Show top rated']
      : ['Shop', 'Auto', 'Service'],
    results
  });
});

app.post('/chat/initiate', auth, allow(Role.CUSTOMER), async (req, res) => {
  const { vendorId, driverId } = req.body || {};
  if (!vendorId && !driverId) return jsonError(res, 400, 'vendorId or driverId required');
  if (vendorId && driverId) return jsonError(res, 400, 'choose one target');

  const room = await prisma.chatRoom.create({ data: { customerId: req.user.sub, vendorId, driverId } });
  return res.status(201).json({ chatRoom: room });
});

app.post('/chat/save-message', auth, async (req, res) => {
  const { chatRoomId, message } = req.body || {};
  if (!chatRoomId || !message) return jsonError(res, 400, 'chatRoomId and message required');

  const room = await prisma.chatRoom.findUnique({ where: { id: chatRoomId }, include: { vendor: true, driver: true } });
  if (!room) return jsonError(res, 404, 'room not found');

  const allowed = req.user.sub === room.customerId || req.user.sub === room.vendor?.userId || req.user.sub === room.driver?.userId;
  if (!allowed) return jsonError(res, 403, 'forbidden');

  const saved = await prisma.message.create({ data: { chatRoomId, message, senderId: req.user.sub } });
  return res.json({ message: saved });
});

app.post('/order/create', auth, allow(Role.CUSTOMER), async (req, res) => {
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
  }

  return res.status(201).json({ order });
});

app.get('/admin/leads', auth, allow(Role.ADMIN), async (req, res) => {
  const { page, pageSize, skip } = parsePagination(req.query);
  const items = await prisma.lead.findMany({
    include: {
      customer: { select: { id: true, name: true, phone: true } },
      vendor: { include: { user: true } },
      driver: { include: { user: true } },
      serviceAgent: { include: { user: true } }
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take: pageSize
  });
  return res.json({ page, pageSize, items });
});

app.get('/history', auth, async (req, res) => {
  const history = await prisma.chatRoom.findMany({
    where: { OR: [{ customerId: req.user.sub }, { vendor: { userId: req.user.sub } }, { driver: { userId: req.user.sub } }] },
    include: { messages: { orderBy: { timestamp: 'asc' } }, vendor: { include: { user: true } }, driver: { include: { user: true } } },
    orderBy: { updatedAt: 'desc' }
  });
  return res.json({ history });
});

app.use((err, _req, res, _next) => {
  console.error('backend_error', err);
  return jsonError(res, 500, 'internal_error');
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`backend listening on ${port}`);
});
