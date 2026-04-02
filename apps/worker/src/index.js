import { ChatRoomDO } from './chat-room-do.js';

const otpBucket = new Map();
const rateBucket = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function limit(key, perMinute = 60) {
  const now = Date.now();
  const item = rateBucket.get(key) || { count: 0, start: now };
  if (now - item.start > 60000) {
    item.count = 0;
    item.start = now;
  }
  item.count += 1;
  rateBucket.set(key, item);
  return item.count <= perMinute;
}

async function verifyJwt(token, secret) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
}

async function proxy(request, env, pathname) {
  const target = `${env.BACKEND_URL}${pathname}`;
  const init = {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text()
  };
  return fetch(target, init);
}

export { ChatRoomDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';

    if (!limit(ip, 120)) return json({ error: 'rate_limited' }, 429);

    if (url.pathname === '/health') return json({ ok: true, service: 'worker' });

    if (url.pathname === '/auth/send-otp' && request.method === 'POST') {
      const { phone } = await request.json().catch(() => ({}));
      if (!phone) return json({ error: 'phone required' }, 400);
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      otpBucket.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });

      if (env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'otp@hyperlocal.app', to: [`${phone}@example.invalid`], subject: 'Your OTP', html: `<b>${otp}</b>` })
        });
      }

      return json({ ok: true, ...(env.DEV_EXPOSE_OTP ? { otp } : {}) });
    }

    if (url.pathname === '/auth/verify-otp' && request.method === 'POST') {
      const { phone, otp } = await request.json().catch(() => ({}));
      const row = otpBucket.get(phone);
      if (!row || row.expires < Date.now() || row.otp !== otp) return json({ error: 'invalid otp' }, 401);
      return proxy(request, env, '/auth/verify-otp');
    }

    if (url.pathname.startsWith('/realtime/')) {
      const roomId = url.pathname.split('/').at(-1);
      const token = request.headers.get('authorization')?.replace('Bearer ', '') || url.searchParams.get('token');
      if (!token) return json({ error: 'missing token' }, 401);
      const claims = await verifyJwt(token, env.JWT_SECRET);
      if (!claims) return json({ error: 'invalid token' }, 401);

      const doId = env.CHAT_ROOM_DO.idFromName(roomId);
      const doUrl = new URL('https://do/ws');
      doUrl.searchParams.set('roomId', roomId);
      doUrl.searchParams.set('userId', claims.sub);
      doUrl.searchParams.set('token', token);
      return env.CHAT_ROOM_DO.get(doId).fetch(doUrl.toString(), request);
    }

    const protectedRoutes = ['/user/register', '/vendors/nearby', '/drivers/nearby', '/chat/initiate', '/chat/save-message', '/order/create', '/history'];
    if (protectedRoutes.some((p) => url.pathname.startsWith(p))) {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      if (!token) return json({ error: 'missing token' }, 401);
      const claims = await verifyJwt(token, env.JWT_SECRET);
      if (!claims) return json({ error: 'invalid token' }, 401);
      return proxy(request, env, url.pathname + url.search);
    }

    return json({ error: 'not_found' }, 404);
  }
};
