const API = localStorage.getItem('workerUrl') || 'http://localhost:8787';
const WHATSAPP_VERIFY_NUMBER = '+919744917623';
let token = localStorage.getItem('token');
let roomId = null;
let socket = null;
let fullPhone = '';
let userRole = 'CUSTOMER';
let selectedVehicleType = null;
let selectedPlan = null;
let userLocation = null;

const onboardingState = {
  deviceId: getOrCreateDeviceId(),
  profile: {},
  conversationMemory: []
};

const $ = (id) => document.getElementById(id);
const slides = Array.from(document.querySelectorAll('.slide'));

function showSlide(name) {
  for (const slide of slides) {
    slide.classList.toggle('active', slide.dataset.slide === name);
  }
}

function getOrCreateDeviceId() {
  const existing = localStorage.getItem('deviceId');
  if (existing) return existing;
  const id = crypto?.randomUUID?.() || `device-${Date.now()}`;
  localStorage.setItem('deviceId', id);
  return id;
}

function addFeedLine(text) {
  const p = document.createElement('p');
  p.textContent = text;
  $('feed').appendChild(p);
}

function renderQuickReplies(replies = []) {
  const guidance = $('guidance');
  guidance.innerHTML = '';
  if (!replies.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'row-buttons';

  for (const reply of replies) {
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = reply;
    b.onclick = () => {
      $('messageInput').value = reply;
      $('sendMsg').click();
    };
    wrap.appendChild(b);
  }

  guidance.appendChild(wrap);
}

const COUNTRY_DIAL_CODE_MAP = {
  IN: '+91', US: '+1', CA: '+1', GB: '+44', AE: '+971', SA: '+966', AU: '+61', SG: '+65'
};

function detectCountryFromLocale() {
  const locale = (navigator.language || '').toUpperCase();
  return locale.split('-')[1] || null;
}

function detectCountryCodeFromLocale() {
  const country = detectCountryFromLocale();
  return COUNTRY_DIAL_CODE_MAP[country] || '+1';
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('geolocation_unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 2500,
      maximumAge: 300000
    });
  });
}

async function detectCountryCode() {
  try {
    const { coords } = await getCurrentPosition();
    const reverseUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.latitude}&lon=${coords.longitude}`;
    const res = await fetch(reverseUrl, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      const country = data?.address?.country_code?.toUpperCase();
      if (country && COUNTRY_DIAL_CODE_MAP[country]) return COUNTRY_DIAL_CODE_MAP[country];
    }
  } catch {
    // fallback to locale
  }

  return detectCountryCodeFromLocale();
}

$('verifyPhone').onclick = async () => {
  const localNumber = $('phone').value.trim().replace(/\D/g, '');
  if (localNumber.length < 8) {
    $('phoneHint').textContent = 'Please enter a valid WhatsApp number.';
    return;
  }

  const countryCode = await detectCountryCode();
  fullPhone = `${countryCode}${localNumber}`;
  onboardingState.profile.phone = fullPhone;
  $('phoneHint').textContent = `Detected ${countryCode}. We will verify ${fullPhone}`;

  try {
    const res = await fetch(`${API}/auth/send-otp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': onboardingState.deviceId,
        'x-app-id': 'vyntaro',
        'x-client-channel': 'pwa'
      },
      body: JSON.stringify({ phone: fullPhone })
    });
    if (!res.ok) throw new Error('Failed to initiate WhatsApp verification');

    const message = encodeURIComponent('VYNTARO verify my number');
    const waDigits = WHATSAPP_VERIFY_NUMBER.replace(/[^\d]/g, '');
    window.location.assign(`https://wa.me/${waDigits}?text=${message}`);
    $('otpHint').textContent = 'After sending the WhatsApp message, wait for OTP and enter it here.';
    showSlide('otp');
  } catch {
    $('phoneHint').textContent = 'Could not start WhatsApp verification. Please retry.';
  }
};

$('verifyOtp').onclick = async () => {
  const otp = $('otp').value.trim();
  if (!otp || otp.length !== 6) {
    $('otpHint').textContent = 'Please enter a valid 6-digit OTP.';
    return;
  }
  try {
    const res = await fetch(`${API}/auth/verify-otp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': onboardingState.deviceId,
        'x-app-id': 'vyntaro',
        'x-client-channel': 'pwa'
      },
      body: JSON.stringify({ phone: fullPhone, otp })
    });
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error();

    token = data.token;
    localStorage.setItem('token', token);
    showSlide('roleCustomer');
  } catch {
    $('otpHint').textContent = 'Invalid OTP. Please check and try again.';
  }
};

$('customerYes').onclick = () => {
  userRole = 'CUSTOMER';
  showSlide('customerDetails');
};
$('customerNo').onclick = () => showSlide('roleDriver');
$('driverYes').onclick = () => {
  userRole = 'DRIVER';
  showSlide('driverVehicleType');
};
$('driverNo').onclick = () => showSlide('roleShop');
$('shopYes').onclick = async () => {
  userRole = 'VENDOR';
  await submitOnboarding('vendor', { category: 'GROCERY', isPaid: false });
  showSlide('pending');
};
$('shopNo').onclick = () => {
  userRole = 'CUSTOMER';
  showSlide('customerDetails');
};

$('captureLocation').onclick = () => {
  if (!navigator.geolocation) {
    $('locationLabel').textContent = 'Location is not available in this device/browser.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      userLocation = { lat: coords.latitude, lng: coords.longitude };
      $('locationLabel').textContent = `Location captured: ${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`;
    },
    () => {
      $('locationLabel').textContent = 'Unable to capture location. Please allow permission.';
    }
  );
};

$('completeCustomer').onclick = async () => {
  const name = $('customerName').value.trim();
  if (!name) return alert('Please enter your name');
  if (!$('agreement').checked) return alert('Please accept agreement to continue');

  await completeRegistration({ name, role: 'CUSTOMER', lastLocation: userLocation });
  showSlide('chatBox');
  renderQuickReplies(['Shop groceries', 'Book auto', 'Find plumber']);
};

$('autoYes').onclick = () => {
  selectedVehicleType = 'AUTO';
  showSlide('driverDetails');
};
$('taxiYes').onclick = () => {
  selectedVehicleType = 'TAXI';
  showSlide('driverDetails');
};
$('taxiNo').onclick = () => {
  userRole = 'CUSTOMER';
  showSlide('customerDetails');
};

$('toSubscription').onclick = () => {
  if (!selectedVehicleType) return alert('Please pick Auto or Taxi to continue.');
  showSlide('subscription');
};

document.querySelectorAll('.plan').forEach((button) => {
  button.onclick = () => {
    selectedPlan = button.dataset.plan;
    document.querySelectorAll('.plan').forEach((p) => p.classList.remove('selected'));
    button.classList.add('selected');
  };
});

$('completeDriver').onclick = async () => {
  if (!selectedPlan) return alert('Please select monthly or yearly subscription.');

  await submitOnboarding('driver', {
    vehicleType: selectedVehicleType,
    plan: selectedPlan
  });
  showSlide('pending');
};

async function completeRegistration(payload) {
  if (!token) return;
  await fetch(`${API}/user/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-device-id': onboardingState.deviceId
    },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

async function submitOnboarding(type, payload) {
  if (!token) return;
  await fetch(`${API}/onboarding/${type}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

$('sendMsg').onclick = async () => {
  const text = $('messageInput').value.trim();
  if (!text || !token) return;

  onboardingState.conversationMemory.push({ role: 'user', message: text, at: new Date().toISOString() });
  addFeedLine(`You: ${text}`);

  const res = await fetch(`${API}/chat/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: text, lat: userLocation?.lat, lng: userLocation?.lng })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    addFeedLine('Bot: Sorry, I could not process that.');
    return;
  }

  renderQuickReplies(data.quickReplies || []);
  renderList(data.results || []);
  addFeedLine(`Bot: Intent ${data.intent || 'UNKNOWN'} detected. ${data.results?.length || 0} nearby options found.`);
};

function renderList(items) {
  const list = $('list');
  list.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = `<button>${item.name || item.id} (${Math.round(item.distanceKm || 0)} km)</button>`;
    li.querySelector('button').onclick = () => initChat(item.kind, item.id);
    list.appendChild(li);
  }
}

async function initChat(kind, id) {
  const payload = kind === 'vendor' ? { vendorId: id } : { driverId: id };
  const res = await fetch(`${API}/chat/initiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  roomId = data.chatRoom?.id;
  if (!roomId) return;
  startSocket();
}

function startSocket() {
  const wsUrl = API.replace('http', 'ws') + `/realtime/${roomId}?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(wsUrl);
  socket.onmessage = (evt) => {
    const d = JSON.parse(evt.data);
    if (d.type === 'message') addFeedLine(`${d.userId}: ${d.text}`);
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
