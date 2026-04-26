export async function onRequest(context) {
  const { request, params, env } = context;
  const fallbackBackend = 'https://chatbotord-production.up.railway.app';
  const backendBase = String(env.backendUrl || env.BACKEND_URL || fallbackBackend).replace(/\/+$/, '');
  if (!backendBase) {
    return new Response(JSON.stringify({ error: 'backend_not_configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }

  const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  const url = new URL(request.url);
  const target = `${backendBase}/${path}${url.search || ''}`;
  const headers = new Headers(request.headers);
  headers.set('x-pages-proxy', 'v1');
  headers.set('x-forwarded-host', new URL(request.url).host);

  const requestBody = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const maxRedirects = 3;
  let redirectCount = 0;
  let currentTarget = target;
  let proxied;

  while (redirectCount <= maxRedirects) {
    proxied = await fetch(currentTarget, {
      method: request.method,
      headers,
      body: requestBody,
      redirect: 'manual'
    });
    if (![301, 302, 303, 307, 308].includes(proxied.status)) break;
    const location = proxied.headers.get('location');
    if (!location) break;
    currentTarget = new URL(location, currentTarget).toString();
    redirectCount += 1;
  }

  return new Response(proxied.body, {
    status: proxied.status,
    headers: proxied.headers
  });
}
