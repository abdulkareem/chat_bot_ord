const bucket = new Map();

export function allowRequest(ip, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  const key = ip || 'unknown';
  const v = bucket.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > v.resetAt) {
    v.count = 0;
    v.resetAt = now + windowMs;
  }
  v.count += 1;
  bucket.set(key, v);
  return v.count <= limit;
}
