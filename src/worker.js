import { ChatRoomDO } from './do/chat-room.js';
import { allowRequest } from './core/rate-limit.js';
import { html, json } from './core/response.js';
import * as api from './api/handlers.js';
import { loginScreen, homeScreen, chatScreen, onboardingScreen, adminDashboardScreen } from './ui/templates/screens.js';
import { getDb } from './db/index.js';
import { expireSubscriptions } from './services/subscription.js';
import { pushDailyInsight } from './cron/analytics.js';
import { STYLE_CSS } from './ui/static/styles.js';

function validateRequiredEnv(env) {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'CHAT_MAX_FILE_BYTES', 'CHAT_FILE_TTL_MS'];
  const missing = required.filter((key) => !env[key]);
  return missing;
}

const routes = [
  ['POST', '/admin/send-otp', api.adminSendOtp],
  ['POST', '/admin/verify-otp', api.adminVerifyOtp],
  ['GET', '/admin/users', api.adminUsers],
  ['GET', '/admin/chats', api.adminChats],
  ['GET', '/admin/subscriptions', api.adminSubscriptions],
  ['GET', '/admin/analytics', api.adminAnalytics],
  ['POST', '/auth/login', api.login],
  ['POST', '/onboarding/verify', api.onboardingVerify],
  ['GET', '/onboarding/status', api.onboardingStatus],
  ['POST', '/onboarding/request-otp', api.onboardingRequestOtp],
  ['POST', '/onboarding/verify-otp', api.onboardingVerifyOtp],
  ['POST', '/onboarding/role', api.onboardingRole],
  ['POST', '/onboarding/location', api.onboardingLocation],
  ['POST', '/onboarding/consent', api.onboardingConsent],
  ['POST', '/onboarding/subscription', api.onboardingSubscription],
  ['POST', '/admin/onboarding/approve', api.adminApproveOnboarding],
  ['POST', '/subscription/upload', api.subscriptionUpload],
  ['POST', '/subscription/verify', api.subscriptionVerify],
  ['GET', '/subscription/status', api.subscriptionStatus],
  ['GET', '/nearby/drivers', api.nearbyDrivers],
  ['GET', '/nearby/shops', api.nearbyShops],
  ['POST', '/chat/start', api.chatStart],
  ['POST', '/chat/message', api.chatMessage]
];

export { ChatRoomDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!allowRequest(request.headers.get('cf-connecting-ip'))) {
      return json({ error: 'rate limit' }, 429);
    }

    if (url.pathname === '/') return html(loginScreen());
    if (url.pathname === '/home') return html(homeScreen());
    if (url.pathname === '/chat') return html(chatScreen());
    if (url.pathname === '/onboarding') return html(onboardingScreen());
    if (url.pathname === '/admin') return html(adminDashboardScreen());
    if (url.pathname === '/static/styles.css') return new Response(STYLE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } });
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(JSON.stringify({
        name: 'Vyntaro',
        short_name: 'Vyntaro',
        display: 'standalone',
        start_url: '/onboarding',
        scope: '/',
        background_color: '#0b0d18',
        theme_color: '#7c5cff',
        icons: []
      }), { headers: { 'content-type': 'application/manifest+json' } });
    }
    if (url.pathname === '/service-worker.js') {
      return new Response(`const CACHE='vyntaro-pwa-v1';self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/onboarding','/home','/chat','/static/styles.css','/manifest.webmanifest'])))});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))) });self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c));return r;}).catch(()=>caches.match(e.request))) });`, { headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    }

    if (url.pathname === '/test') {
      const missing = validateRequiredEnv(env);
      if (missing.length) return json({ ok: false, missing }, 500);
      return json({ ok: true, service: 'vyntarochat' });
    }

    if (url.pathname.startsWith('/realtime/')) {
      const roomId = url.pathname.split('/').at(-1);
      const id = env.CHAT_ROOM_DO.idFromName(roomId);
      return env.CHAT_ROOM_DO.get(id).fetch(`https://do/ws?${url.searchParams.toString()}`);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/analytics/')) {
      const id = url.pathname.split('/').at(-1);
      return api.analyticsById(request, env, id);
    }

    for (const [m, p, h] of routes) {
      if (request.method === m && url.pathname === p) return h(request, env);
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env) {
    const db = getDb(env);
    await expireSubscriptions(db);
    await pushDailyInsight(db, event);
  }
};
