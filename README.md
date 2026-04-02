# PulseLane Hyperlocal Chat Platform

Production-grade MVP on Cloudflare Workers + Durable Objects + PostgreSQL.

## Folder Structure

- `src/worker.js` Worker entrypoint (API, SSR, cron)
- `src/do/chat-room.js` Durable Object WebSocket chat room
- `src/api/handlers.js` API handlers
- `src/services/*` business services (subscription, access, soft-order capture)
- `src/db/schema.sql` PostgreSQL schema
- `src/ui/*` SSR templates + design system

## Unique UI Identity

The app uses a **"Aurora Glass"** design language:
- gradient cloud background
- glassmorphism cards
- bold purple-cyan action gradient
- non-chat-app visual metaphor with flow tiles

## Required Endpoints
Implemented:
- `POST /auth/login`
- `POST /onboarding/verify`
- `POST /subscription/upload`
- `POST /subscription/verify`
- `GET /subscription/status`
- `GET /nearby/drivers`
- `GET /nearby/shops`
- `POST /chat/start`
- `POST /chat/message`
- `GET /analytics/:id`

## Setup
1. `npm i`
2. Create Railway Postgres and set `DATABASE_URL` in Wrangler secrets:
   `wrangler secret put DATABASE_URL`
3. Configure JWT secret:
   `wrangler secret put JWT_SECRET`
4. Create/link database schema (safe to run multiple times):
   `DATABASE_URL="postgres://..." npm run db:init`
5. Run locally:
   `npm run dev`
6. Deploy:
   `npm run deploy`

## Connect Cloudflare Worker to Railway Postgres

Your Worker already reads the database URL from `env.DATABASE_URL` (`src/db/index.js`), so the main work is configuring secrets and Railway networking correctly.

### 1) Get the correct Railway connection string
- In Railway → your Postgres service → **Connect**.
- Copy the **Public Networking** URL.
- Ensure SSL is required by adding `?sslmode=require` when needed.

Example format:
`postgresql://postgres:<PASSWORD>@<HOST>:<PORT>/railway?sslmode=require`

### 2) Set the secret in Cloudflare
From your project root:

```bash
wrangler secret put DATABASE_URL
```

Paste the Railway URL when prompted.

Also set your JWT secret if you have not already:

```bash
wrangler secret put JWT_SECRET
```

### 3) Keep secrets out of `wrangler.toml`
- Do **not** commit raw credentials inside `[vars]`.
- Keep non-sensitive config in `[vars]`, and credentials in `wrangler secret`.

### 4) Initialize schema in Railway
Run this from your local machine (or CI) against Railway:

```bash
DATABASE_URL="postgresql://...railway?sslmode=require" npm run db:init
```

### 5) Verify runtime configuration
Local/dev:

```bash
npm run dev
curl http://127.0.0.1:8787/test
```

Production:

```bash
curl https://vyntarochat.abdulkareem-t.workers.dev/test
```

If response includes missing `DATABASE_URL`, your secret is not set for that environment.

### Login/registration UI update
- The root route `/` now opens the onboarding flow directly (instead of the old phone-role-OTP form).
- If the old screen still appears, clear service worker cache once and reload (cache key upgraded to `vyntaro-pwa-v2`).

### Deployment stuck in "pending"

If your pipeline stays pending for a long time, it is usually because Wrangler is waiting for interactive authentication.  
The deploy script in this repo now runs with `CI=1` so Wrangler uses CI mode and fails fast instead of hanging indefinitely.

For CI/CD, set these environment variables in your deployment platform:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Scale Notes (100K users)
- Edge APIs on Workers reduce latency.
- Durable Object sharding by chat id avoids single-node bottlenecks.
- Indexed read paths for messages/discovery/subscriptions.
- Background cron for subscription expiry and analytics insights.
- Async event inserts for analytics/order capture.

## Security/Hardening
- Stateless bearer token auth via HMAC.
- Request rate limiting at edge.
- Verification + subscription gating for search/chat/offers.
- File-proof metadata capture (upload URL/reference model).

## Feature Coverage
- Verification workflow (driver/shop docs, customer OTP)
- 1-month free trial auto-provisioning
- GST-aware subscription plans and manual proof verification
- Realtime chat with text/image/location/offer/bill/payment + typing events
- Offer broadcasting primitives
- Soft-order extraction from message content
- Analytics API and chat-delivered daily insight message
