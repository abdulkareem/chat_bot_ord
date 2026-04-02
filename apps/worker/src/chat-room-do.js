export class ChatRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const userId = url.searchParams.get('userId');
      const token = url.searchParams.get('token');
      if (!userId || !token) return new Response('Missing auth', { status: 401 });
      await this.accept(server, userId, token, url.searchParams.get('roomId'));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  async accept(socket, userId, token, roomId) {
    socket.accept();
    this.sockets.set(userId, socket);
    this.broadcast({ type: 'presence', userId, state: 'online' });

    socket.addEventListener('message', async (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type !== 'message') return;

        const message = {
          type: 'message',
          userId,
          roomId,
          text: payload.text,
          ts: new Date().toISOString()
        };

        this.broadcast(message);

        await fetch(`${this.env.BACKEND_URL}/chat/save-message`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ chatRoomId: roomId, message: payload.text })
        });
      } catch {
        socket.send(JSON.stringify({ type: 'error', error: 'invalid_payload' }));
      }
    });

    socket.addEventListener('close', () => {
      this.sockets.delete(userId);
      this.broadcast({ type: 'presence', userId, state: 'offline' });
    });
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const socket of this.sockets.values()) {
      socket.send(raw);
    }
  }
}
