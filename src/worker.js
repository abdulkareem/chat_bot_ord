import { ChatRoomDO } from './do/chat-room.js';
import { allowRequest } from './core/rate-limit.js';
import { html, json } from './core/response.js';
import * as api from './api/handlers.js';
import { loginScreen, homeScreen, chatScreen } from './ui/templates/screens.js';
import { getDb } from './db/index.js';
import { expireSubscriptions } from './services/subscription.js';
import { pushDailyInsight } from './cron/analytics.js';
import { STYLE_CSS } from './ui/static/styles.js';

const routes = [
  ['POST', '/auth/login', api.login],
  ['POST', '/onboarding/verify', api.onboardingVerify],
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
    if (url.pathname === '/static/styles.css') return new Response(STYLE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } });

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

  async scheduled(_ctrl, env) {
    const sql = getDb(env);
    await expireSubscriptions(sql);
    await pushDailyInsight(sql);
  }
};
