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
  const [h, p, s] = String(token || '').split('.');
  if (!h || !p || !s) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)), enc.encode(`${h}.${p}`));
  if (!ok) return null;
  return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
}

async function proxy(request, env, pathname) {
  const target = `${env.BACKEND_URL}${pathname}`;
  const headers = new Headers(request.headers);
  headers.set('x-worker-gateway', 'v1');
  const init = {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text()
  };
  return fetch(target, init);
}

function makeCorsHeaders(origin = '*') {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-device-id,x-app-id,x-client-channel'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: makeCorsHeaders(request.headers.get('origin') || '*') });
    if (!limit(ip, 120)) return json({ error: 'rate_limited' }, 429);

    if (url.pathname === '/health') return json({ ok: true, service: 'worker', backend: env.BACKEND_URL, time: new Date().toISOString() });

    if (url.pathname === '/auth/send-otp' && request.method === 'POST') {
      const { phone } = await request.json().catch(() => ({}));
      if (!phone) return json({ error: 'phone required' }, 400);
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      otpBucket.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });
      return json({ ok: true, ...(env.DEV_EXPOSE_OTP === 'true' ? { otp } : {}) });
    }

    if (url.pathname === '/auth/verify-otp' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({}));
      const row = otpBucket.get(payload.phone);
      if (!row || row.expires < Date.now() || row.otp !== payload.otp) return json({ error: 'invalid otp' }, 401);
      return proxy(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(payload) }), env, '/auth/verify-otp');
    }

    if (url.pathname === '/chat/message' && request.method === 'POST') {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      if (!token) return json({ error: 'missing token' }, 401);
      const claims = await verifyJwt(token, env.JWT_SECRET);
      if (!claims) return json({ error: 'invalid token' }, 401);
      return proxy(request, env, '/chat/intent');
    }

    if (url.pathname === '/ws' || url.pathname.startsWith('/realtime/')) {
      const token = request.headers.get('authorization')?.replace('Bearer ', '') || url.searchParams.get('token');
      if (!token) return json({ error: 'missing token' }, 401);
      const claims = await verifyJwt(token, env.JWT_SECRET);
      if (!claims) return json({ error: 'invalid token' }, 401);
      const backendUrl = new URL(`${env.BACKEND_URL}/ws`);
      backendUrl.searchParams.set('token', token);
      return fetch(new Request(backendUrl.toString(), request));
    }

    const publicRoutes = ['/auth/send-otp', '/auth/verify-otp', '/health'];
    const protectedPrefixes = [
      '/user/register', '/vendors/nearby', '/drivers/nearby', '/services/nearby', '/chat/initiate', '/chat/save-message', '/order/create', '/history',
      '/onboarding/', '/admin/'
    ];

    if (publicRoutes.includes(url.pathname)) return proxy(request, env, url.pathname + url.search);

    if (protectedPrefixes.some((p) => url.pathname.startsWith(p))) {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      if (!token) return json({ error: 'missing token' }, 401);
      const claims = await verifyJwt(token, env.JWT_SECRET);
      if (!claims) return json({ error: 'invalid token' }, 401);
      return proxy(request, env, url.pathname + url.search);
    }

    return json({ error: 'not_found' }, 404);
  }
};
