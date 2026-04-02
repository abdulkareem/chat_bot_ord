import { layout } from './layout.js';

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
  body: `<section class="card"><h1>Welcome to Vyntaro</h1><p id="statusText">Enter your WhatsApp number to continue.</p>
    <div class="grid">
      <input id="phone" placeholder="WhatsApp number" />
      <button id="verifyBtn">Verify</button>
      <input id="otp" placeholder="Enter 6-digit OTP" style="display:none" />
    </div>

    <div id="roleCard" class="grid" style="display:none;margin-top:14px">
      <h3>How do you want to use this app?</h3>
      <select id="role"><option value="CUSTOMER">👤 Customer</option><option value="AUTO_DRIVER">🚖 Auto Driver</option><option value="SHOP_OWNER">🏪 Shop Owner</option></select>
      <button id="continueRole">Continue</button>
    </div>

    <div id="customerCard" class="grid" style="display:none;margin-top:14px">
      <input id="customerName" placeholder="Your name" />
      <label><input id="consent" type="checkbox" /> I agree to Terms and permit legal usage of my number, name, location and chat history.</label>
      <button id="saveCustomer">Finish Customer Setup</button>
    </div>

    <div id="driverCard" class="grid" style="display:none;margin-top:14px">
      <input id="driverName" placeholder="Driver name" />
      <input id="vehicleNumber" placeholder="Vehicle number" />
      <input id="rcOwner" placeholder="RC owner name" />
      <select id="driverPlan"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
      <button id="saveDriver">Save Driver Profile</button>
    </div>

    <div id="shopCard" class="grid" style="display:none;margin-top:14px">
      <input id="shopName" placeholder="Shop name" />
      <input id="ownerName" placeholder="Owner name" />
      <input id="shopAddress" placeholder="Shop address" />
      <input id="shopCategory" placeholder="Category" />
      <select id="shopPlan"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
      <button id="saveShop">Save Shop Profile</button>
      <small>Tip: Use mobile GPS for free map pinpoint accuracy.</small>
    </div>
    <pre id="output"></pre></section>`,
  script: `
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
    const output = document.getElementById('output');
    let token = null;
    let userId = null;
    let currentRole = null;
    const headers = () => ({ 'content-type': 'application/json', 'x-app-id': 'vyntaro', 'x-client-channel': 'pwa', ...(token ? { authorization: 'Bearer ' + token } : {}) });
    const print = (x) => output.textContent = JSON.stringify(x, null, 2);
    const setStatus = (text) => document.getElementById('statusText').textContent = text;
    async function post(path, body) { const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'request failed'); return data; }
    const show = (id, yes) => document.getElementById(id).style.display = yes ? 'block' : 'none';
    const getDeviceId = () => {
      let id = localStorage.getItem('vyntaro_device_id');
      if (!id) {
        id = 'web-' + crypto.randomUUID();
        localStorage.setItem('vyntaro_device_id', id);
      }
      return id;
    };
    let otpStepActive = false;
    const normalizeWhatsappInput = (value) => {
      const digits = String(value || '').replace(/\\D/g, '');
      if (!digits) return '';
      if (digits.length === 10) return '+91' + digits;
      if (digits.startsWith('91') && digits.length === 12) return '+' + digits;
      return value.trim().startsWith('+') ? value.trim() : ('+' + digits);
    };
    const getLocation = () => new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition((pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }), () => resolve(null), { timeout: 8000 });
    });

    document.getElementById('verifyBtn').onclick = async () => {
      const phoneInput = document.getElementById('phone');
      const whatsappNumber = normalizeWhatsappInput(phoneInput.value);
      if (!whatsappNumber) {
        setStatus('Please enter your WhatsApp number first.');
        return;
      }
      phoneInput.value = whatsappNumber;
      const verifyBtn = document.getElementById('verifyBtn');
      if (otpStepActive) {
        const otp = document.getElementById('otp').value.trim();
        if (!otp) {
          setStatus('Please enter the OTP you received.');
          return;
        }
        const location = await getLocation();
        const data = await post('/auth/whatsapp/verify', { whatsappNumber, deviceId: getDeviceId(), otp, location });
        token = data.token;
        userId = data.user?.id || null;
        print(data);
        setStatus('OTP verified. Select your app usage mode.');
        show('roleCard', true);
        return;
      }
      const deviceId = getDeviceId();
      const data = await post('/auth/whatsapp/initiate', { whatsappNumber, deviceId });
      print(data);
      if (data.mode === 'device_login' && data.token) {
        token = data.token;
        setStatus('Device already registered. Logged in.');
        location.href = '/home';
        return;
      }
      const text = 'VYNTARO verify my account';
      const to = '9744917623';
      window.location.href = 'https://wa.me/' + to + '?text=' + encodeURIComponent(text);
      setStatus('After sending the WhatsApp message, enter the OTP below and tap Verify again (valid for 5 minutes).');
      show('otp', true);
      otpStepActive = true;
      verifyBtn.textContent = 'Enter OTP & Verify';
    };

    document.getElementById('continueRole').onclick = async () => {
      currentRole = document.getElementById('role').value;
      show('customerCard', currentRole === 'CUSTOMER');
      show('driverCard', currentRole === 'AUTO_DRIVER');
      show('shopCard', currentRole === 'SHOP_OWNER');
    };

    document.getElementById('saveCustomer').onclick = async () => {
      const consentOk = document.getElementById('consent').checked;
      const data = await post('/register/user', { name: document.getElementById('customerName').value.trim(), whatsappNumber: document.getElementById('phone').value.trim(), role: 'customer', consent: { acceptedTerms: consentOk } });
      print(data); setStatus('Customer registration complete.');
    };

    document.getElementById('saveDriver').onclick = async () => {
      if (!userId) {
        setStatus('Please complete OTP verification first.');
        return;
      }
      const location = await getLocation();
      const data = await post('/register/driver', { userId, driverName: document.getElementById('driverName').value.trim(), vehicleNumber: document.getElementById('vehicleNumber').value.trim(), rcOwner: document.getElementById('rcOwner').value.trim(), phone: document.getElementById('phone').value.trim(), planType: document.getElementById('driverPlan').value, location });
      print(data); setStatus('Driver submitted. Free 1 month started. Wait for super admin approval.');
    };

    document.getElementById('saveShop').onclick = async () => {
      if (!userId) {
        setStatus('Please complete OTP verification first.');
        return;
      }
      const location = await getLocation();
      const data = await post('/register/shop', { userId, shopName: document.getElementById('shopName').value.trim(), ownerName: document.getElementById('ownerName').value.trim(), shopAddress: document.getElementById('shopAddress').value.trim(), category: document.getElementById('shopCategory').value.trim(), phone: document.getElementById('phone').value.trim(), planType: document.getElementById('shopPlan').value, location });
      print(data); setStatus('Shop submitted with map location. Free 1 month started. Wait for super admin approval.');
    };
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
