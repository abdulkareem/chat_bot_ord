import express from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient, Role, VendorCategory, VehicleType, OrderType, OrderStatus } from '@prisma/client';

const app = express();
const prisma = new PrismaClient();
app.use(express.json());

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function allow(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'railway-backend' }));

app.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  return res.json({ ok: true, otp: process.env.DEV_OTP || '123456' });
});

app.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body || {};
  if (!phone || !otp) return res.status(400).json({ error: 'phone and otp required' });
  if ((process.env.DEV_OTP || '123456') !== String(otp)) return res.status(401).json({ error: 'invalid otp' });

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    user = await prisma.user.create({ data: { phone, role: Role.CUSTOMER, name: 'New User' } });
  }
  const token = jwt.sign({ sub: user.id, role: user.role, phone: user.phone }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return res.json({ token, user });
});

app.post('/user/register', auth, async (req, res) => {
  const { name, role, lastLocation, vendor, driver } = req.body || {};
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

  if (validRole === Role.VENDOR && vendor) {
    await prisma.vendor.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        category: vendor.category || VendorCategory.GROCERY,
        isPaid: Boolean(vendor.isPaid),
        rating: vendor.rating || 0
      },
      update: {
        category: vendor.category || undefined,
        isPaid: vendor.isPaid,
        rating: vendor.rating
      }
    });
  }

  if (validRole === Role.DRIVER && driver) {
    await prisma.driver.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        vehicleType: driver.vehicleType || VehicleType.AUTO,
        isAvailable: driver.isAvailable ?? true
      },
      update: {
        vehicleType: driver.vehicleType || undefined,
        isAvailable: driver.isAvailable
      }
    });
  }

  return res.json({ user });
});

app.get('/vendors/nearby', auth, allow(Role.CUSTOMER), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const category = req.query.category;
  const maxKm = Number(req.query.maxKm || 10);

  const customer = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const sourceLat = Number.isFinite(lat) ? lat : customer?.lastLatitude;
  const sourceLng = Number.isFinite(lng) ? lng : customer?.lastLongitude;
  if (!Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) return res.status(400).json({ error: 'location required' });

  const interactedVendorIds = (await prisma.chatRoom.findMany({ where: { customerId: req.user.sub, vendorId: { not: null } }, select: { vendorId: true } }))
    .map((r) => r.vendorId)
    .filter(Boolean);

  const vendors = await prisma.vendor.findMany({
    where: {
      ...(category ? { category } : {}),
      user: { lastLatitude: { not: null }, lastLongitude: { not: null } }
    },
    include: { user: true }
  });

  const ranked = vendors
    .map((v) => ({
      ...v,
      distanceKm: distanceKm(sourceLat, sourceLng, v.user.lastLatitude, v.user.lastLongitude),
      previouslyInteracted: interactedVendorIds.includes(v.id)
    }))
    .filter((v) => v.distanceKm <= maxKm)
    .sort((a, b) => Number(b.isPaid) - Number(a.isPaid) || Number(b.previouslyInteracted) - Number(a.previouslyInteracted) || b.rating - a.rating || a.distanceKm - b.distanceKm);

  return res.json({ vendors: ranked });
});

app.get('/drivers/nearby', auth, allow(Role.CUSTOMER), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const vehicleType = req.query.type;
  const maxKm = Number(req.query.maxKm || 10);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat/lng required' });

  const drivers = await prisma.driver.findMany({
    where: {
      isAvailable: true,
      ...(vehicleType ? { vehicleType } : {}),
      user: { lastLatitude: { not: null }, lastLongitude: { not: null } }
    },
    include: { user: true }
  });

  const nearby = drivers
    .map((d) => ({ ...d, distanceKm: distanceKm(lat, lng, d.user.lastLatitude, d.user.lastLongitude) }))
    .filter((d) => d.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return res.json({ drivers: nearby });
});

app.post('/chat/initiate', auth, allow(Role.CUSTOMER), async (req, res) => {
  const { vendorId, driverId } = req.body || {};
  if (!vendorId && !driverId) return res.status(400).json({ error: 'vendorId or driverId required' });
  if (vendorId && driverId) return res.status(400).json({ error: 'choose one target' });

  const room = await prisma.chatRoom.create({ data: { customerId: req.user.sub, vendorId, driverId } });
  return res.json({ chatRoom: room });
});

app.post('/chat/save-message', auth, async (req, res) => {
  const { chatRoomId, message } = req.body || {};
  if (!chatRoomId || !message) return res.status(400).json({ error: 'chatRoomId and message required' });

  const room = await prisma.chatRoom.findUnique({ where: { id: chatRoomId }, include: { vendor: true, driver: true } });
  if (!room) return res.status(404).json({ error: 'room not found' });

  const allowed = req.user.sub === room.customerId || req.user.sub === room.vendor?.userId || req.user.sub === room.driver?.userId;
  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  const saved = await prisma.message.create({ data: { chatRoomId, message, senderId: req.user.sub } });
  return res.json({ message: saved });
});

app.post('/order/create', auth, allow(Role.CUSTOMER), async (req, res) => {
  const { type, vendorId, driverId, metadata } = req.body || {};
  if (!type || !Object.values(OrderType).includes(type)) return res.status(400).json({ error: 'valid type required' });

  const order = await prisma.orderRide.create({
    data: {
      type,
      status: OrderStatus.PENDING,
      customerId: req.user.sub,
      vendorId,
      driverId,
      metadata
    }
  });

  return res.json({ order });
});

app.get('/history', auth, async (req, res) => {
  const history = await prisma.chatRoom.findMany({
    where: { OR: [{ customerId: req.user.sub }, { vendor: { userId: req.user.sub } }, { driver: { userId: req.user.sub } }] },
    include: { messages: { orderBy: { timestamp: 'asc' } }, vendor: { include: { user: true } }, driver: { include: { user: true } } },
    orderBy: { updatedAt: 'desc' }
  });
  return res.json({ history });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`backend listening on ${port}`);
});

