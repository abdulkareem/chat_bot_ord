const API = localStorage.getItem('workerUrl') || 'http://localhost:8787';
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
  profile: {}
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

function detectCountryCode() {
  const locale = (navigator.language || '').toUpperCase();
  const map = {
    IN: '+91', US: '+1', CA: '+1', GB: '+44', AE: '+971', SA: '+966', AU: '+61', SG: '+65'
  };
  const suffix = locale.split('-')[1];
  return map[suffix] || '+91';
}

$('verifyPhone').onclick = () => {
  const localNumber = $('phone').value.trim().replace(/\D/g, '');
  if (localNumber.length < 8) {
    $('phoneHint').textContent = 'Please enter a valid WhatsApp number.';
    return;
  }

  const countryCode = detectCountryCode();
  fullPhone = `${countryCode}${localNumber}`;
  onboardingState.profile.phone = fullPhone;
  $('phoneHint').textContent = `Detected ${countryCode}. Using ${fullPhone}`;

  const message = encodeURIComponent(`VYNTARO verify my number ${fullPhone}`);
  const waUrl = `https://wa.me/919744917623?text=${message}`;
  window.open(waUrl, '_blank');
  showSlide('waSent');
};

$('continueAfterWa').onclick = async () => {
  try {
    const res = await fetch(`${API}/auth/send-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': onboardingState.deviceId },
      body: JSON.stringify({ phone: fullPhone })
    });
    if (!res.ok) throw new Error('Failed to send OTP');
    showSlide('otp');
  } catch {
    $('phoneHint').textContent = 'Could not send OTP. Please retry.';
    showSlide('phone');
  }
};

$('verifyOtp').onclick = async () => {
  const otp = $('otp').value.trim();
  try {
    const res = await fetch(`${API}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': onboardingState.deviceId },
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
  await completeRegistration({
    name: 'Shop Owner',
    role: 'VENDOR',
    vendor: { category: 'GROCERY', isPaid: false, rating: 0 }
  });
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

  onboardingState.profile = { ...onboardingState.profile, name, role: 'CUSTOMER', location: userLocation };
  await completeRegistration({ name, role: 'CUSTOMER', lastLocation: userLocation });
  showSlide('chatBox');
};

$('autoYes').onclick = () => {
  selectedVehicleType = 'AUTO';
  showSlide('driverDetails');
};
$('autoNo').onclick = () => {
  selectedVehicleType = null;
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
  const driverName = $('driverName').value.trim();
  const vehicleNumber = $('vehicleNumber').value.trim();
  const licenseNumber = $('licenseNumber').value.trim();
  const ownerName = $('ownerName').value.trim();

  if (!driverName || !vehicleNumber || !licenseNumber || !ownerName) {
    return alert('Please fill all driver/vehicle fields.');
  }

  onboardingState.profile = {
    ...onboardingState.profile,
    role: 'DRIVER',
    driverName,
    vehicleNumber,
    licenseNumber,
    ownerName,
    vehicleType: selectedVehicleType
  };

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

  await completeRegistration({
    name: onboardingState.profile.driverName,
    role: 'DRIVER',
    lastLocation: userLocation,
    driver: {
      vehicleType: selectedVehicleType,
      isAvailable: true
    }
  });
  showSlide('pending');
};

async function completeRegistration(payload) {
  localStorage.setItem('onboardingData', JSON.stringify({
    ...onboardingState,
    userRole,
    selectedPlan,
    submittedAt: new Date().toISOString()
  }));

  if (!token) return;
  try {
    await fetch(`${API}/user/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-device-id': onboardingState.deviceId
      },
      body: JSON.stringify(payload)
    });
  } catch {
    // keep onboarding locally even if backend registration fails
  }
}

$('sendMsg').onclick = async () => {
  const text = $('messageInput').value.trim();
  if (!text) return;

  if (text.toLowerCase() === 'hi') {
    $('guidance').textContent = 'How can I help you? Options: Shop / Auto / Taxi';
    return;
  }

  if (/shop/i.test(text)) {
    const res = await fetch(`${API}/vendors/nearby?category=GROCERY&lat=12.97&lng=77.59`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    renderList(data.vendors || [], 'vendor');
    return;
  }

  if (/auto|taxi/i.test(text)) {
    const type = /taxi/i.test(text) ? 'TAXI' : 'AUTO';
    const res = await fetch(`${API}/drivers/nearby?type=${type}&lat=12.97&lng=77.59`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    renderList(data.drivers || [], 'driver');
  }
};

function renderList(items, kind) {
  const list = $('list');
  list.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = `<button>${item.user?.name || item.id} (${Math.round(item.distanceKm || 0)} km)</button>`;
    li.querySelector('button').onclick = () => initChat(kind, item.id);
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
    if (d.type === 'message') {
      const p = document.createElement('p');
      p.textContent = `${d.userId}: ${d.text}`;
      $('feed').appendChild(p);
    }
  };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js');
