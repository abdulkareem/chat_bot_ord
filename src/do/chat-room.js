export class ChatRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/ws')) {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const userId = url.searchParams.get('user_id') || crypto.randomUUID();
      this.acceptSocket(server, userId);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
      const payload = await request.json();
      this.broadcast({ type: 'message', ...payload });
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  }

  acceptSocket(socket, userId) {
    socket.accept();
    this.sessions.set(userId, socket);
    this.broadcast({ type: 'presence', user_id: userId, status: 'online' });

    socket.addEventListener('message', (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === 'typing') {
        this.broadcast({ type: 'typing', user_id: userId, chat_id: data.chat_id });
      } else {
        this.broadcast({ type: 'message', user_id: userId, payload: data });
      }
    });

    socket.addEventListener('close', () => {
      this.sessions.delete(userId);
      this.broadcast({ type: 'presence', user_id: userId, status: 'offline' });
    });
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const socket of this.sessions.values()) {
      socket.send(msg);
    }
  }
}
