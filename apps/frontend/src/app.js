const API = localStorage.getItem('workerUrl') || 'http://localhost:8787';
let token = localStorage.getItem('token');
let socket = null;
let roomId = null;

const $ = (id) => document.getElementById(id);

$('sendOtp').onclick = async () => {
  const phone = $('phone').value.trim();
  await fetch(`${API}/auth/send-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  alert('OTP sent');
};

$('verifyOtp').onclick = async () => {
  const phone = $('phone').value.trim();
  const otp = $('otp').value.trim();
  const res = await fetch(`${API}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, otp })
  });
  const data = await res.json();
  token = data.token;
  localStorage.setItem('token', token);
  $('flow').classList.remove('hidden');
};

$('sendMsg').onclick = async () => {
  const text = $('messageInput').value.trim();
  if (!text) return;

  if (text.toLowerCase() === 'hi') {
    $('guidance').textContent = 'How can I help you? Options: Shop / Auto / Taxi';
    $('results').classList.remove('hidden');
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
  roomId = data.chatRoom.id;
  startSocket();
}

function startSocket() {
  $('chat').classList.remove('hidden');
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
