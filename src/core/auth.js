const encoder = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/g, '');
}

export async function signToken(payload, secret) {
  const encoded = btoa(JSON.stringify(payload));
  const sig = await hmac(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifyToken(token, secret) {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expected = await hmac(secret, encoded);
  if (expected !== sig) return null;
  return JSON.parse(atob(encoded));
}

export async function requireAuth(req, env) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, env.JWT_SECRET);
}
