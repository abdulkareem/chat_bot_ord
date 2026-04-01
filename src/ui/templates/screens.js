import { layout } from './layout.js';

export const loginScreen = () => layout({
  title: 'Vyntaro • Login',
  body: `<section class="card"><h1>Vyntaro</h1><p>Connect instantly with nearby autos and shops.</p>
  <form id="loginForm"><input name="phone" placeholder="Phone"/><select name="role"><option value="STUDENT">Student</option><option value="IPO">IPO</option><option value="COLLEGE_COORDINATOR">College Coordinator</option><option value="DEPARTMENT_COORDINATOR">Department Coordinator</option><option value="ADMIN">Admin</option><option value="SUPER_ADMIN">Super Admin</option></select><input name="otp" placeholder="OTP (student only)"/><button>Enter</button></form><pre id="out"></pre></section>`,
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
  title: 'Vyntaro • Home',
  body: `<section><h2>What do you want?</h2><div class="grid"><a class="tile" href="/discovery?type=drivers">🚖 Find Auto</a><a class="tile" href="/discovery?type=shops">🛒 Shop Nearby</a><a class="tile" href="/chat">Realtime Chat</a></div></section>`
});

export const chatScreen = () => layout({
  title: 'Vyntaro • Realtime Chat',
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

export const onboardingScreen = () => layout({
  title: 'Vyntaro • Onboarding',
  body: `<section class="card">
    <h1>Vyntaro</h1>
    <p id="statusText">Verify your number to continue</p>
    <div class="grid">
      <input id="phone" placeholder="Phone number" />
      <input id="deviceId" placeholder="Device ID" />
      <button id="checkUser">Check Account</button>
      <button id="verifyBtn">VERIFY</button>
      <input id="otp" placeholder="Enter 6-digit OTP" />
      <button id="submitOtp">Submit OTP</button>
      <select id="role">
        <option value="STUDENT">👤 Customer</option>
        <option value="IPO">🚖 Auto Driver</option>
        <option value="COLLEGE_COORDINATOR">🏪 Shop Owner</option>
      </select>
      <button id="saveRole">Save Role</button>
      <button id="saveLocation">Save My Location</button>
      <label><input id="consent" type="checkbox" /> I agree to terms: phone, location and chat data processing.</label>
      <button id="saveConsent">Accept Terms</button>
      <select id="planType">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
      <button id="startTrial">Start Free Trial (1 Month)</button>
      <input id="paymentReference" placeholder="Payment reference" />
      <input id="paymentProofUrl" placeholder="Payment proof URL" />
      <button id="subscribeNow">Subscribe Now</button>
    </div>
    <pre id="output"></pre>
  </section>`,
  script: `
    const output = document.getElementById('output');
    let token = null;
    const headers = () => ({ 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) });
    const print = (x) => output.textContent = JSON.stringify(x, null, 2);
    const setStatus = (text) => document.getElementById('statusText').textContent = text;

    async function post(path, body) {
      const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'request failed');
      return data;
    }

    document.getElementById('checkUser').onclick = async () => {
      const phone = document.getElementById('phone').value.trim();
      const deviceId = document.getElementById('deviceId').value.trim();
      const res = await fetch('/onboarding/status?phone=' + encodeURIComponent(phone) + '&device_id=' + encodeURIComponent(deviceId));
      const data = await res.json();
      print(data);
      setStatus(data.verify_prompt || ('Next step: ' + data.next_step));
      if (data.next_step === 'chat') location.href = '/home';
    };

    document.getElementById('verifyBtn').onclick = async () => {
      const phone = document.getElementById('phone').value.trim();
      const data = await post('/onboarding/request-otp', { phone });
      setStatus('OTP sent on WhatsApp');
      print(data);
    };

    document.getElementById('submitOtp').onclick = async () => {
      const phone = document.getElementById('phone').value.trim();
      const device_id = document.getElementById('deviceId').value.trim();
      const otp = document.getElementById('otp').value.trim();
      const data = await post('/onboarding/verify-otp', { phone, device_id, otp });
      token = data.token;
      setStatus('Verified. Select your role.');
      print(data);
    };

    document.getElementById('saveRole').onclick = async () => print(await post('/onboarding/role', { role: document.getElementById('role').value }));
    document.getElementById('saveLocation').onclick = async () => navigator.geolocation.getCurrentPosition(async (pos) => {
      const data = await post('/onboarding/location', { lat: pos.coords.latitude, lng: pos.coords.longitude, available: true });
      setStatus('Location saved. Accept terms.');
      print(data);
    });
    document.getElementById('saveConsent').onclick = async () => print(await post('/onboarding/consent', { accepted_terms: document.getElementById('consent').checked }));
    document.getElementById('startTrial').onclick = async () => {
      const data = await post('/onboarding/subscription', { action: 'trial', plan_type: document.getElementById('planType').value });
      print(data);
      if (data.next_step === 'chat') location.href = '/home';
    };
    document.getElementById('subscribeNow').onclick = async () => print(await post('/onboarding/subscription', {
      action: 'subscribe',
      plan_type: document.getElementById('planType').value,
      payment_reference: document.getElementById('paymentReference').value,
      payment_proof_url: document.getElementById('paymentProofUrl').value
    }));
  `
});
