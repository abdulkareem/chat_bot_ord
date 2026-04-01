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
4. Apply schema on DB:
   `psql "$DATABASE_URL" -f src/db/schema.sql`
5. Run locally:
   `npm run dev`
6. Deploy:
   `npm run deploy`

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
