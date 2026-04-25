# Hyperlocal Chat Marketplace Monorepo

## Production architecture

`Phase 1 (cost-optimized): PWA (Cloudflare Pages frontend) -> Railway Backend (REST + WebSocket) -> PostgreSQL + Redis + BullMQ workers`

`Phase 2 (optional hardening): PWA -> Cloudflare Worker (auth/API gateway + websocket passthrough) -> Railway Backend -> PostgreSQL + Redis + BullMQ workers`

## Apps

- `apps/frontend`: chat-first PWA (customer onboarding + quick-reply chat UX)
- `apps/worker`: Cloudflare Worker routing/auth/rate-limit/gateway + Durable Object realtime relay
- `apps/backend`: Express + Prisma business logic, unified WebSocket chat router, admin/onboarding APIs
- `packages/db/prisma`: shared Prisma schema source of truth (includes services/roles/chat session models)

## Mandatory env variables

### Backend (Railway)

- `DATABASE_URL`
- `JWT_SECRET`
- `REDIS_URL` (required for cache, distributed rate limits, queue)
- `CORS_ORIGIN` (recommended for direct frontend->backend in Phase 1, e.g. `https://your-pages-domain.pages.dev`)
- `ENABLE_BACKGROUND_WORKERS` (`true/false`, optional)
- `PORT` (optional)
- `DEV_OTP` (optional for local dev)

### Worker (Cloudflare)

> Optional in Phase 1. Required only if you run gateway mode.

- `BACKEND_URL` (**Railway public URL, not localhost**)
- `JWT_SECRET`
- `DEV_EXPOSE_OTP` (`true/false`, optional)

### Frontend (PWA)

- Phase 1 (recommended for cost): point frontend directly to Railway backend:
  - `localStorage.setItem('backendUrl', 'https://<your-railway-backend-domain>')`
  - or set Cloudflare Pages build variable `backendUrl` (lowercase) so build emits `runtime-config.js`
  - or set Pages Functions variable `backendUrl` and use built-in proxy via `/api/*` (no browser CORS dependency)
  - repository default fallback points to `https://chatbotord-production.up.railway.app` if no variable is set
- Phase 2 (gateway mode): point frontend to Worker:
  - `localStorage.setItem('workerUrl', 'https://<your-worker-domain>')`

## Core APIs

### Auth + profile

- `POST /auth/send-otp`
- `POST /auth/verify-otp`
- `POST /user/register`

### Chat + discovery

- `POST /chat/message` (backward-compatible route backed by unified chat router)
- `GET /services/active`
- `GET /auth/me` (role-based capabilities)
- `WS /ws` (persistent chat engine)
- `GET /vendors/nearby`
- `POST /leads/:id/events`
- `POST /chat/initiate`
- `POST /chat/save-message`

### Monetization + billing

- `POST /vendors/:id/subscription`
- `POST /vendors/:id/boost`

### Analytics

- `GET /analytics/summary`

### Leads + orders

- `POST /order/create`
- `GET /history`

## Local run

```bash
npm install
npm run prisma:generate
npm run dev:backend
npm run dev:worker
cd apps/frontend && npm run dev
```

## Deploy notes

### Backend / Railway

- Start command: `node apps/backend/src/server.js` (or workspace start script)
- Ensure Prisma migrate runs:

```bash
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
```

- Health endpoint: `GET /health`

### Worker / Cloudflare (optional in Phase 1)

```bash
wrangler deploy -c apps/worker/wrangler.toml
```

Set secrets/vars:

```bash
wrangler secret put JWT_SECRET
wrangler secret put BACKEND_URL
```

### Frontend

Deploy static app and point it to `backendUrl` (Phase 1) or Worker URL (Phase 2).
For Pages Functions proxy mode, keep `backendUrl` as a Pages variable and let frontend call `/api/*`.

## Reference design

Detailed scale + monetization blueprint: `docs/scaling-monetization-blueprint.md`.
### Admin controls

- `GET /admin/users`
- `GET /admin/services`
- `POST /admin/services/:id/toggle`
- `GET /admin/chat/activity`
