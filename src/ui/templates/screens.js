import { layout } from './layout.js';

export const loginScreen = () => layout({
  title: 'Vyntaro • Login',
  body: `<section class="card"><h1>Vyntaro</h1><p>Install app and login as customer, auto driver, or shop owner.</p>
  <form id="loginForm"><input name="phone" placeholder="Phone" required/><select name="role"><option value="CUSTOMER">Customer</option><option value="AUTO_DRIVER">Auto Driver</option><option value="SHOP_OWNER">Shop Owner</option></select><input name="otp" placeholder="OTP"/><button>Enter</button></form><pre id="out"></pre></section>`,
  script: `
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
  document.getElementById('loginForm').onsubmit = async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    const r = await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json','x-app-id':'vyntaro','x-client-channel':'pwa'},body:JSON.stringify(payload)});
    document.getElementById('out').textContent = JSON.stringify(await r.json(),null,2);
  }
  `
});

export const homeScreen = () => layout({
  title: 'Vyntaro • Home',
  body: `<section><h2>Discover Nearby</h2><div class="grid"><a class="tile" href="/chat">Realtime Chat</a></div><div id="map" style="height:360px;border-radius:12px;margin-top:16px"></div></section>`,
  script: `
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const map = L.map('map').setView([lat, lng], 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
        L.marker([lat, lng]).addTo(map).bindPopup('You');

        const headers = { 'x-app-id': 'vyntaro', 'x-client-channel': 'pwa' };
        const [drivers, shops] = await Promise.all([
          fetch('/nearby/drivers?lat=' + lat + '&lng=' + lng, { headers }).then(r => r.json()),
          fetch('/nearby/shops?lat=' + lat + '&lng=' + lng, { headers }).then(r => r.json())
        ]);

        (drivers.items || []).forEach((d) => L.marker([d.latitude, d.longitude]).addTo(map).bindPopup('🚕 ' + (d.name || 'Driver')));
        (shops.items || []).forEach((s) => L.marker([s.latitude, s.longitude]).addTo(map).bindPopup('🏪 ' + (s.name || 'Shop')));
      });
    };
    document.body.appendChild(script);
  `
});

export const chatScreen = () => layout({
  title: 'Vyntaro • Realtime Chat',
  body: `<section class="card"><h2>Realtime Chat</h2><input id="roomId" placeholder="Room ID" value="demo-room" /><input id="userId" placeholder="User ID" value="user-${Date.now()}" /><button id="connect">Connect</button><hr /><input id="textMessage" placeholder="Type a message" /><button id="send">Send</button><pre id="messages"></pre></section>`,
  script: `
  const out = document.getElementById('messages');
  let socket;
  const log = (msg) => out.textContent += msg + '\n';
  document.getElementById('connect').onclick = () => {
    const roomId = encodeURIComponent(document.getElementById('roomId').value.trim());
    const userId = encodeURIComponent(document.getElementById('userId').value.trim());
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(protocol + '://' + location.host + '/realtime/' + roomId + '?user_id=' + userId + '&app_id=vyntaro');
    socket.onopen = () => log('connected');
    socket.onmessage = (evt) => log(evt.data);
  };
  document.getElementById('send').onclick = () => {
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'text', text: document.getElementById('textMessage').value }));
  };
  `
});

export const onboardingScreen = () => layout({
  title: 'Vyntaro • Onboarding',
  body: `<section class="card"><h1>Vyntaro App Onboarding</h1><p id="statusText">Verify your number to continue</p><div class="grid"><input id="phone" placeholder="Phone number" /><input id="deviceId" placeholder="Device ID" /><button id="checkUser">Check Account</button><button id="verifyBtn">VERIFY</button><input id="otp" placeholder="Enter 6-digit OTP" /><button id="submitOtp">Submit OTP</button><select id="role"><option value="CUSTOMER">👤 Customer</option><option value="AUTO_DRIVER">🚖 Auto Driver</option><option value="SHOP_OWNER">🏪 Shop Owner</option></select><button id="saveRole">Save Role</button><button id="saveLocation">Save My Location</button><label><input id="consent" type="checkbox" /> I agree to terms.</label><button id="saveConsent">Accept Terms</button><select id="planType"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select><button id="startTrial">Start Free Trial</button><input id="paymentReference" placeholder="Payment reference" /><input id="paymentProofUrl" placeholder="Payment proof URL" /><button id="subscribeNow">Subscribe Now</button></div><pre id="output"></pre></section>`,
  script: `
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
    const output = document.getElementById('output');
    let token = null;
    const headers = () => ({ 'content-type': 'application/json', 'x-app-id': 'vyntaro', 'x-client-channel': 'pwa', ...(token ? { authorization: 'Bearer ' + token } : {}) });
    const print = (x) => output.textContent = JSON.stringify(x, null, 2);
    const setStatus = (text) => document.getElementById('statusText').textContent = text;
    async function post(path, body) { const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'request failed'); return data; }
    document.getElementById('checkUser').onclick = async () => { const phone = document.getElementById('phone').value.trim(); const deviceId = document.getElementById('deviceId').value.trim(); const res = await fetch('/onboarding/status?phone=' + encodeURIComponent(phone) + '&device_id=' + encodeURIComponent(deviceId), { headers: { 'x-app-id': 'vyntaro', 'x-client-channel': 'pwa' } }); const data = await res.json(); print(data); setStatus(data.verify_prompt || ('Next step: ' + data.next_step)); if (data.next_step === 'chat') location.href = '/home'; };
    document.getElementById('verifyBtn').onclick = async () => { const phone = document.getElementById('phone').value.trim(); const data = await post('/onboarding/request-otp', { phone }); setStatus('OTP sent on WhatsApp'); print(data); };
    document.getElementById('submitOtp').onclick = async () => { const phone = document.getElementById('phone').value.trim(); const device_id = document.getElementById('deviceId').value.trim(); const otp = document.getElementById('otp').value.trim(); const data = await post('/onboarding/verify-otp', { phone, device_id, otp }); token = data.token; print(data); };
    document.getElementById('saveRole').onclick = async () => print(await post('/onboarding/role', { role: document.getElementById('role').value }));
    document.getElementById('saveLocation').onclick = async () => navigator.geolocation.getCurrentPosition(async (pos) => print(await post('/onboarding/location', { lat: pos.coords.latitude, lng: pos.coords.longitude, available: true })));
    document.getElementById('saveConsent').onclick = async () => print(await post('/onboarding/consent', { accepted_terms: document.getElementById('consent').checked }));
    document.getElementById('startTrial').onclick = async () => print(await post('/onboarding/subscription', { action: 'trial', plan_type: document.getElementById('planType').value }));
    document.getElementById('subscribeNow').onclick = async () => print(await post('/onboarding/subscription', { action: 'subscribe', plan_type: document.getElementById('planType').value, payment_reference: document.getElementById('paymentReference').value, payment_proof_url: document.getElementById('paymentProofUrl').value }));
  `
});

export const adminDashboardScreen = () => layout({
  title: 'Vyntaro • Super Admin',
  body: `<section class="card"><h1>Super Admin Dashboard (Web only)</h1><p>Enter super admin token to load visibility data.</p><input id="token" placeholder="Bearer token" /><button id="load">Load Dashboard</button><pre id="out"></pre></section>`,
  script: `
    document.getElementById('load').onclick = async () => {
      const token = document.getElementById('token').value.trim();
      const headers = { authorization: token.startsWith('Bearer ') ? token : ('Bearer ' + token), 'x-app-id': 'vyntaro', 'x-client-channel': 'web' };
      const [users, chats, subscriptions, analytics] = await Promise.all([
        fetch('/admin/users', { headers }).then(r => r.json()),
        fetch('/admin/chats', { headers }).then(r => r.json()),
        fetch('/admin/subscriptions', { headers }).then(r => r.json()),
        fetch('/admin/analytics', { headers }).then(r => r.json())
      ]);
      document.getElementById('out').textContent = JSON.stringify({ users, chats, subscriptions, analytics }, null, 2);
    }
  `
});
