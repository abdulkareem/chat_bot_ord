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
  body: `<section><h2>Choose Flow</h2><div class="grid"><a class="tile" href="/discovery?type=drivers">Get Auto</a><a class="tile" href="/discovery?type=shops">Shop Nearby</a></div></section>`
});
