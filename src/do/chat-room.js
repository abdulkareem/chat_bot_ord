const DEFAULT_FILE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_FILE_TYPES = ['application/pdf'];

export class ChatRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.files = new Map();
    this.fileTtlMs = Number(env.CHAT_FILE_TTL_MS || DEFAULT_FILE_TTL_MS);
    this.maxFileBytes = Number(env.CHAT_MAX_FILE_BYTES || DEFAULT_MAX_FILE_BYTES);
    this.cleanupTimer = setInterval(() => this.cleanupExpiredFiles(), DEFAULT_CLEANUP_INTERVAL_MS);
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

    if (request.method === 'POST' && url.pathname.endsWith('/end')) {
      this.endSession();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  }

  acceptSocket(socket, userId) {
    socket.accept();
    this.sessions.set(userId, socket);
    this.broadcast({ type: 'presence', user_id: userId, status: 'online' });

    socket.addEventListener('message', (evt) => {
      this.handleSocketMessage(evt, userId, socket);
    });

    socket.addEventListener('close', () => {
      this.sessions.delete(userId);
      this.broadcast({ type: 'presence', user_id: userId, status: 'offline' });
      if (this.sessions.size === 0) this.clearFiles();
    });
  }

  handleSocketMessage(evt, userId, socket) {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }

    if (data.type === 'typing') {
      this.broadcast({ type: 'typing', user_id: userId, chat_id: data.chat_id });
      return;
    }

    if (data.type === 'file') {
      const validation = this.validateFileMessage(data);
      if (!validation.ok) {
        socket.send(JSON.stringify({ type: 'error', error: validation.error }));
        return;
      }

      const fileId = data.fileId || crypto.randomUUID();
      const fileRecord = {
        fileId,
        fileName: this.sanitizeFileName(data.fileName || 'file'),
        fileType: data.fileType,
        fileData: data.fileData,
        sender: userId,
        timestamp: Date.now(),
        size: this.estimateDataSizeBytes(data.fileData)
      };

      this.files.set(fileId, fileRecord);
      this.broadcast({ type: 'file', ...fileRecord });
      return;
    }

    this.broadcast({ type: 'message', user_id: userId, payload: data });
  }

  validateFileMessage(payload) {
    if (!payload.fileData || typeof payload.fileData !== 'string') {
      return { ok: false, error: 'missing_file_data' };
    }
    if (!payload.fileType || typeof payload.fileType !== 'string') {
      return { ok: false, error: 'missing_file_type' };
    }

    const isImage = payload.fileType.startsWith('image/');
    const allowedType = isImage || ALLOWED_FILE_TYPES.includes(payload.fileType);
    if (!allowedType) {
      return { ok: false, error: 'unsupported_file_type' };
    }

    const bytes = this.estimateDataSizeBytes(payload.fileData);
    if (bytes > this.maxFileBytes) {
      return { ok: false, error: 'file_too_large' };
    }

    return { ok: true };
  }

  estimateDataSizeBytes(fileData) {
    if (!fileData.startsWith('data:')) {
      return Math.ceil((fileData.length * 3) / 4);
    }

    const base64Part = fileData.split(',')[1] || '';
    const pad = (base64Part.match(/=+$/) || [''])[0].length;
    return Math.ceil((base64Part.length * 3) / 4) - pad;
  }

  sanitizeFileName(name) {
    return name
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120);
  }

  cleanupExpiredFiles() {
    const now = Date.now();
    for (const [id, file] of this.files) {
      if (now - file.timestamp > this.fileTtlMs) {
        this.files.delete(id);
      }
    }
  }

  clearFiles() {
    this.files.clear();
  }

  endSession() {
    this.clearFiles();
  }

  broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const socket of this.sessions.values()) {
      socket.send(msg);
    }
  }
}
