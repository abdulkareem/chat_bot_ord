export async function onRequest(context) {
  const { request, params, env } = context;
  const backendBase = String(env.backendUrl || env.BACKEND_URL || '').replace(/\/+$/, '');
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

  const proxied = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow'
  });

  return new Response(proxied.body, {
    status: proxied.status,
    headers: proxied.headers
  });
}
