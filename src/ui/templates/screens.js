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
  body: `<section class="card"><h1>Welcome to Vyntaro</h1>
  <p id="status">Enter phone number without country code.</p>
  <input id="phone" placeholder="Phone number" />
  <button id="startBtn">Start Verification</button>
  <input id="otp" placeholder="6-digit OTP" style="display:none" />
  <button id="verifyBtn" style="display:none">Verify OTP</button>

  <div id="onboarding" style="display:none" class="grid">
    <input id="name" placeholder="Your full name" />
    <label><input type="checkbox" id="terms" /> I accept Terms</label>
    <label><input type="checkbox" id="privacy" /> I accept Privacy Policy</label>
    <select id="role">
      <option value="CUSTOMER">Customer (Free)</option>
      <option value="VENDOR">Vendor (Paid)</option>
      <option value="DRIVER">Driver (Paid)</option>
      <option value="SERVICE_PROVIDER">Service Provider (Paid)</option>
    </select>

    <div id="vendorFields" style="display:none">
      <input id="shopName" placeholder="Shop name" />
      <input id="category" placeholder="Category" />
      <input id="contactDetails" placeholder="Contact details" />
      <input id="workingHours" placeholder="Working hours" />
    </div>

    <div id="driverFields" style="display:none">
      <input id="vehicleType" placeholder="Vehicle type" />
      <input id="licenseDetails" placeholder="License details" />
      <input id="availability" placeholder="Availability" />
    </div>

    <div id="serviceFields" style="display:none">
      <input id="serviceType" placeholder="Service type" />
      <input id="serviceArea" placeholder="Service area" />
      <input id="experienceYears" placeholder="Experience years" />
    </div>

    <button id="saveOnboarding">Complete Onboarding</button>
  </div>

  <div id="subscriptionCard" class="grid" style="display:none">
    <h3>Activate subscription</h3>
    <select id="planType"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
    <button id="payBtn">Activate Plan</button>
  </div>

  <pre id="out"></pre>
  </section>`,
  script: `
    const headers = (token = null) => ({ 'content-type':'application/json','x-app-id':'vyntaro','x-client-channel':'pwa', ...(token ? { authorization: 'Bearer ' + token } : {}) });
    const out = document.getElementById('out');
    const status = document.getElementById('status');
    let token = localStorage.getItem('vyntaro_token');
    let normalizedPhone = '';
    let lastVerification = null;
    const deviceId = localStorage.getItem('vyntaro_device_id') || ('web-' + crypto.randomUUID());
    localStorage.setItem('vyntaro_device_id', deviceId);

    const role = document.getElementById('role');
    const reflectRole = () => {
      document.getElementById('vendorFields').style.display = role.value === 'VENDOR' ? 'block' : 'none';
      document.getElementById('driverFields').style.display = role.value === 'DRIVER' ? 'block' : 'none';
      document.getElementById('serviceFields').style.display = role.value === 'SERVICE_PROVIDER' ? 'block' : 'none';
    };
    role.onchange = reflectRole;
    reflectRole();

    async function post(path, body) {
      const res = await fetch(path, { method:'POST', headers: headers(token), body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'request failed');
      return data;
    }

    function openWhatsapp(verification) {
      if (!verification) throw new Error('verification links missing');
      const deepLink = verification.whatsappDeepLink;
      const webLink = verification.whatsappWebLink;
      if (!webLink) throw new Error('whatsapp link missing');

      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
      if (isMobile && deepLink) {
        const startedAt = Date.now();
        window.location.href = deepLink;
        setTimeout(() => {
          if (document.visibilityState === 'visible' && Date.now() - startedAt < 2200) {
            window.location.href = webLink;
          }
        }, 1200);
        return;
      }
      window.open(webLink, '_blank', 'noopener,noreferrer');
    }

    function setOut(data) { out.textContent = JSON.stringify(data, null, 2); }
    function getLocation() {
      return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { timeout: 7000 });
      });
    }

    document.getElementById('startBtn').onclick = async () => {
      try {
        const loc = await getLocation();
        const data = await post('/auth/request-whatsapp', { phone: document.getElementById('phone').value.trim(), deviceId, location: loc });
        normalizedPhone = data.phone;
        lastVerification = data.verification || null;
        setOut(data);
        status.textContent = 'WhatsApp opened. Send verification message and enter OTP.';
        openWhatsapp(lastVerification);
        document.getElementById('otp').style.display = 'block';
        document.getElementById('verifyBtn').style.display = 'inline-block';
      } catch (e) { status.textContent = e.message; }
    };

    document.getElementById('verifyBtn').onclick = async () => {
      try {
        const otpValue = document.getElementById('otp').value.trim();
        if (!otpValue) {
          openWhatsapp(lastVerification);
          status.textContent = 'WhatsApp reopened. Send the verification message, then enter OTP.';
          return;
        }
        const loc = await getLocation();
        const data = await post('/auth/verify-otp', { phone: normalizedPhone || document.getElementById('phone').value.trim(), otp: otpValue, deviceId, location: loc });
        token = data.token;
        localStorage.setItem('vyntaro_token', token);
        setOut(data);
        status.textContent = 'Phone verified. Complete onboarding.';
        document.getElementById('onboarding').style.display = 'grid';
      } catch (e) { status.textContent = e.message; }
    };

    document.getElementById('saveOnboarding').onclick = async () => {
      try {
        const loc = await getLocation();
        const payload = {
          name: document.getElementById('name').value.trim(),
          acceptTerms: document.getElementById('terms').checked,
          acceptPrivacy: document.getElementById('privacy').checked,
          role: document.getElementById('role').value,
          location: loc,
          vendorProfile: {
            shopName: document.getElementById('shopName').value.trim(),
            category: document.getElementById('category').value.trim(),
            contactDetails: document.getElementById('contactDetails').value.trim(),
            workingHours: document.getElementById('workingHours').value.trim()
          },
          driverProfile: {
            vehicleType: document.getElementById('vehicleType').value.trim(),
            licenseDetails: document.getElementById('licenseDetails').value.trim(),
            availability: document.getElementById('availability').value.trim()
          },
          serviceProfile: {
            serviceType: document.getElementById('serviceType').value.trim(),
            serviceArea: document.getElementById('serviceArea').value.trim(),
            experienceYears: document.getElementById('experienceYears').value.trim()
          }
        };
        const data = await post('/onboarding', payload);
        setOut(data);
        if (data.requiresSubscription) {
          document.getElementById('subscriptionCard').style.display = 'grid';
          status.textContent = 'Onboarding submitted. Activate subscription to receive leads.';
        } else {
          status.textContent = 'Onboarding complete. Opening chat...';
          location.href = '/chat';
        }
      } catch (e) { status.textContent = e.message; }
    };

    document.getElementById('payBtn').onclick = async () => {
      try {
        const step1 = await post('/subscription/activate', { planType: document.getElementById('planType').value });
        setOut(step1);
        status.textContent = 'Demo mode: submit Razorpay success payload to finalize.';
      } catch (e) { status.textContent = e.message; }
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
