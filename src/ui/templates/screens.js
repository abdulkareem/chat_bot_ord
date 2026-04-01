import { layout } from './layout.js';

export const loginScreen = () => layout({
  title: 'PulseLane • Login',
  body: `<section class="card"><h1>PulseLane</h1><p>Hyperlocal chat mesh</p>
  <form id="loginForm"><input name="phone" placeholder="Phone"/><select name="role"><option value="customer">Customer</option><option value="shop_owner">Shop Owner</option><option value="driver">Driver</option></select><input name="otp" placeholder="OTP (customer only)"/><button>Enter</button></form><pre id="out"></pre></section>`,
  script: `
  document.getElementById('loginForm').onsubmit = async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    const r = await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    document.getElementById('out').textContent = JSON.stringify(await r.json(),null,2);
  }
  `
});

export const homeScreen = () => layout({
  title: 'PulseLane • Home',
  body: `<section><h2>Choose Flow</h2><div class="grid"><a class="tile" href="/discovery?type=drivers">Get Auto</a><a class="tile" href="/discovery?type=shops">Shop Nearby</a><a class="tile" href="/chat">Realtime Chat</a></div></section>`
});

export const chatScreen = () => layout({
  title: 'PulseLane • Realtime Chat',
  body: `<section class="card">
    <h2>Realtime Chat + Temporary File Share</h2>
    <input id="roomId" placeholder="Room ID" value="demo-room" />
    <input id="userId" placeholder="User ID" value="user-${Date.now()}" />
    <button id="connect">Connect</button>
    <hr />
    <input id="textMessage" placeholder="Type a message" />
    <button id="send">Send</button>
    <input id="fileInput" type="file" accept="image/*,application/pdf" />
    <pre id="messages"></pre>
    <div id="preview"></div>
  </section>`,
  script: `
  const out = document.getElementById('messages');
  const preview = document.getElementById('preview');
  const fileInput = document.getElementById('fileInput');
  const maxFileBytes = 2 * 1024 * 1024;
  let socket;

  function log(msg) {
    out.textContent += msg + "\\n";
    out.scrollTop = out.scrollHeight;
  }

  function sanitizeText(value) {
    return String(value || '').replace(/[<>]/g, '');
  }

  document.getElementById('connect').onclick = () => {
    const roomId = encodeURIComponent(document.getElementById('roomId').value.trim());
    const userId = encodeURIComponent(document.getElementById('userId').value.trim());
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(protocol + '://' + location.host + '/realtime/' + roomId + '?user_id=' + userId);

    socket.onopen = () => log('connected');
    socket.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.type === 'file') {
        renderFile(data);
      }
      log(JSON.stringify(data));
    };
    socket.onclose = () => log('disconnected');
  };

  document.getElementById('send').onclick = () => {
    if (!socket || socket.readyState !== 1) return;
    const message = document.getElementById('textMessage').value;
    socket.send(JSON.stringify({ type: 'text', text: sanitizeText(message) }));
  };

  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    if (!file || !socket || socket.readyState !== 1) return;

    if (!(file.type.startsWith('image/') || file.type === 'application/pdf')) {
      log('unsupported file type');
      return;
    }
    if (file.size > maxFileBytes) {
      log('file too large (max 2MB)');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      socket.send(JSON.stringify({
        type: 'file',
        fileId: crypto.randomUUID(),
        fileName: file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120),
        fileType: file.type,
        fileData: reader.result
      }));
    };
    reader.readAsDataURL(file);
  };

  function renderFile(file) {
    const block = document.createElement('div');
    const title = document.createElement('p');
    title.textContent = file.fileName + ' (' + file.fileType + ')';
    block.appendChild(title);

    if (file.fileType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = file.fileData;
      img.alt = file.fileName;
      img.style.maxWidth = '240px';
      block.appendChild(img);
    } else {
      const link = document.createElement('a');
      link.href = file.fileData;
      link.textContent = 'Open file';
      link.target = '_blank';
      block.appendChild(link);
    }

    preview.prepend(block);
  }
  `
});
