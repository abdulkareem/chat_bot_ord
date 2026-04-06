const mem = new Map();

async function redisRequest(env, args) {
  if (!env.REDIS_REST_URL || !env.REDIS_REST_TOKEN) return null;
  const res = await fetch(`${env.REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([args])
  });
  if (!res.ok) throw new Error(`redis request failed: ${res.status}`);
  const body = await res.json();
  return body?.[0]?.result ?? null;
}

export async function redisSetEx(env, key, ttlSeconds, value) {
  const payload = JSON.stringify(value);
  const remote = await redisRequest(env, ['SETEX', key, String(ttlSeconds), payload]);
  if (remote === null) {
    mem.set(key, { value: payload, expiry: Date.now() + ttlSeconds * 1000 });
  }
}

export async function redisGet(env, key) {
  const remote = await redisRequest(env, ['GET', key]);
  if (remote !== null) {
    try { return JSON.parse(remote); } catch { return remote; }
  }
  const item = mem.get(key);
  if (!item) return null;
  if (item.expiry < Date.now()) {
    mem.delete(key);
    return null;
  }
  try { return JSON.parse(item.value); } catch { return item.value; }
}

export async function redisDel(env, key) {
  const remote = await redisRequest(env, ['DEL', key]);
  if (remote === null) mem.delete(key);
}
