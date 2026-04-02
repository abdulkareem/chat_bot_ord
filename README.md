# Hyperlocal Chat Marketplace (Production-Oriented Monorepo)

Architecture:

Frontend (PWA) → Cloudflare Worker (Auth + Routing + Rate Limit) → Durable Object (`ChatRoomDO`) → Railway Backend (Express + Prisma) → PostgreSQL.

## Monorepo structure

- `apps/frontend`: mobile-first PWA chat UX.
- `apps/worker`: Cloudflare Worker + Durable Object real-time chat engine.
- `apps/backend`: Railway-ready Node backend with Prisma business APIs.
- `packages/shared`: shared constants.
- `tests`: smoke/unit tests.

## Core flows implemented

- OTP login flow via Worker endpoints (`/auth/send-otp`, `/auth/verify-otp`), Resend-ready.
- Customer “Hi” guided flow in frontend with options: Shop / Auto / Taxi.
- Shop discovery with nearby + previous interaction boosting + paid vendor prioritization.
- Auto/Taxi driver nearby lookup.
- Chat initiation, room-based real-time messaging through Durable Objects.
- Message persistence to backend/PostgreSQL.
- Order/Ride creation endpoint with metadata.

## Required APIs

Implemented in `apps/backend/src/server.js`:

- `POST /auth/send-otp`
- `POST /auth/verify-otp`
- `POST /user/register`
- `GET /vendors/nearby`
- `GET /drivers/nearby`
- `POST /chat/initiate`
- `POST /chat/save-message`
- `POST /order/create`
- `GET /history`

Worker forwards/protects business APIs and owns auth/rate-limit/routing responsibilities.

## Prisma schema

Production schema is at:

- `apps/backend/prisma/schema.prisma`

Includes:

- `User` (role, last location)
- `Vendor` (category, paid priority, rating)
- `Driver` (vehicle type, availability)
- `ChatRoom`
- `Message`
- `OrderRide`

## Environment variables

### Worker

- `JWT_SECRET`
- `BACKEND_URL`
- `RESEND_API_KEY` (optional)
- `DEV_EXPOSE_OTP` (optional)

### Backend

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT` (optional, default `3001`)
- `DEV_OTP` (optional, default `123456`)

## Local development

```bash
npm install
npm run prisma:generate
npm run dev:backend
npm run dev:worker
```

Serve frontend statically (example):

```bash
npx serve apps/frontend/src -l 4173
```

## Railway deployment notes

- Provision PostgreSQL in Railway.
- Set `DATABASE_URL` and `JWT_SECRET`.
- Run migrations on deploy:

```bash
npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
```

## Cloudflare deployment notes

```bash
wrangler deploy -c apps/worker/wrangler.toml
```

Set secrets:

```bash
wrangler secret put JWT_SECRET
wrangler secret put RESEND_API_KEY
```

## Audit + fixes applied

- Split legacy mixed worker/db concerns into strict layer boundaries.
- Removed database access from Worker path; backend-only persistence.
- Added role-based route guards in backend.
- Added rate limiting in Worker.
- Added deterministic endpoints required for onboarding/chat/order history.
- Added geo ranking strategy with paid-vendor prioritization and prior interactions boost.
