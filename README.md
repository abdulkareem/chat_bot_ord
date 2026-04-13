# Hyperlocal Chat Marketplace Monorepo

## Production architecture

`PWA (frontend) -> Cloudflare Worker (auth/API gateway + websocket passthrough) -> Railway Backend (stateful chat engine + business APIs) -> PostgreSQL + Redis + BullMQ workers`

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
- `ENABLE_BACKGROUND_WORKERS` (`true/false`, optional)
- `PORT` (optional)
- `DEV_OTP` (optional for local dev)

### Worker (Cloudflare)

- `BACKEND_URL` (**Railway public URL, not localhost**)
- `JWT_SECRET`
- `DEV_EXPOSE_OTP` (`true/false`, optional)

### Frontend (PWA)

- Frontend must call Worker only. Set worker URL via:
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

### Worker / Cloudflare

```bash
wrangler deploy -c apps/worker/wrangler.toml
```

Set secrets/vars:

```bash
wrangler secret put JWT_SECRET
wrangler secret put BACKEND_URL
```

### Frontend

Deploy static app and point it to Worker URL only.

## Reference design

Detailed scale + monetization blueprint: `docs/scaling-monetization-blueprint.md`.
### Admin controls

- `GET /admin/users`
- `GET /admin/services`
- `POST /admin/services/:id/toggle`
- `GET /admin/chat/activity`
