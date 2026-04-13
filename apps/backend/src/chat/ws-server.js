import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { routeChatMessage } from './chat-router.js';

function tokenFromRequest(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token');
}

export function attachChatWebSocketServer({ server, prisma, jwtSecret, redis }) {
  const wsServer = new WebSocketServer({ noServer: true });
  const onlineUsers = new Map();

  async function setOnlineState(userId, socket, online) {
    if (online) {
      onlineUsers.set(userId, socket);
      if (redis) await redis.sadd('chat:online_users', userId).catch(() => {});
    } else {
      onlineUsers.delete(userId);
      if (redis) await redis.srem('chat:online_users', userId).catch(() => {});
    }
  }

  wsServer.on('connection', async (socket, context) => {
    const { user } = context;
    await setOnlineState(user.sub, socket, true);

    socket.send(JSON.stringify({ type: 'system', message: 'connected', userId: user.sub }));

    socket.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
        return;
      }

      if (payload.type !== 'chat_message') {
        socket.send(JSON.stringify({ type: 'error', error: 'unsupported_type' }));
        return;
      }

      try {
        const routed = await routeChatMessage({ prisma, userId: user.sub, message: payload.message });
        socket.send(JSON.stringify({ type: 'chat_response', ...routed }));
      } catch (error) {
        console.error('ws_route_error', error);
        socket.send(JSON.stringify({ type: 'error', error: 'route_failed' }));
      }
    });

    socket.on('close', async () => {
      await setOnlineState(user.sub, socket, false);
    });
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname !== '/ws') return;

      const token = tokenFromRequest(req);
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const user = jwt.verify(token, jwtSecret);
      const activeSession = await prisma.userSession.findFirst({
        where: {
          userId: user.sub,
          jwtId: user.jti,
          revokedAt: null,
          expiresAt: { gt: new Date() }
        }
      });

      if (!activeSession) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit('connection', ws, { user });
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  return wsServer;
}
