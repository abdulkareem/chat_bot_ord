# Scalable + Monetized Architecture Blueprint (100K Users)

## 1) Updated architecture diagram

```text
Next.js PWA (Cloudflare Pages)
        |
        v
Cloudflare Worker (Edge chat orchestration + auth + API gateway + coarse rate-limit)
        |
        v
Railway Backend (Stateless Express replicas behind LB)
        |
        +-------------------------------+
        |                               |
        v                               v
PostgreSQL (primary source of truth)    Redis (cache + session + rate-limit + queues)
        |                               |
        +---------------+---------------+
                        |
                        v
Background workers (BullMQ): notifications, order processing, analytics rollups
```

## 2) New DB schema highlights (Prisma)

Implemented entities and fields for scale + monetization:
- `Vendor.subscriptionType`, `Vendor.subscriptionExpiry`, `Vendor.priorityScore`
- `Vendor.status`, `Vendor.latitude`, `Vendor.longitude`, `Vendor.avgResponseSeconds`
- `VendorPromotion` for paid boosts
- `VendorSubscriptionInvoice` for plan billing lifecycle
- `PaymentTransaction` for Razorpay/UPI status tracking
- `VendorWallet` + `WalletLedger` for lead-based debits/recharges
- `LeadEvent` for monetizable event instrumentation
- `AnalyticsMetric` for category/revenue/conversion aggregation

## 3) Redis usage design

- **Geo/vendor caching**: `nearby:vendors:*` with TTL 60s (recommended 30–120s window)
- **Rate limiting keys**: `rate:customer:<id>`, `rate:vendor:<id>` using `INCR + EXPIRE`
- **Session memory** (chat) pattern: `chat:session:<userId>` (TTL policy at worker/backend)
- **Queue transport**: BullMQ queues in Redis for `notifications`, `orders`, `analytics`

## 4) Monetization implementation

- **Vendor subscriptions**:
  - Free / Basic / Premium tiers
  - Purchase endpoint updates `subscriptionType`, `subscriptionExpiry`, `priorityScore`
  - Stores invoice + payment transaction records
- **Paid promotions**:
  - Boost listing endpoint writes `VendorPromotion` rows
  - Promotion tied to payment transaction for auditability
- **Lead-based pricing**:
  - Event ingestion endpoint captures `SEARCH`, `VENDOR_CLICK`, `CHAT_STARTED`, `ORDER_INTENT`
  - Wallet auto-debit on chargeable events

## 5) Ranking algorithm

Current backend ranking score:

```text
distanceWeight = max(0, 50 - distanceKm * 8)
ratingWeight = min(25, rating * 5)
responseWeight = max(0, 10 - min(10, avgResponseSeconds / 30))
tierWeight = {FREE:0, BASIC:10, PREMIUM:25}
paidBoost = min(30, activePromotionBoost + paidBoost + priorityScore)

finalScore = distanceWeight + ratingWeight + responseWeight + tierWeight + paidBoost
```

This combines user relevance (distance/quality/response) with monetization levers (tier/promotion).

## 6) API changes

New/updated API capabilities:
- `GET /vendors/nearby`
  - Bounding-box prefilter + exact distance filter
  - Redis cache (60s)
  - Pagination (`page`, `pageSize`)
  - Intelligent ranking output (`score` + rank signals)
- `POST /vendors/:id/subscription`
  - Creates payment transaction + invoice, updates plan
- `POST /vendors/:id/boost`
  - Creates boost promotion with payment record
- `POST /leads/:id/events`
  - Tracks monetizable events + optional wallet debit
- `GET /analytics/summary`
  - Pulls aggregated analytics + total monetized revenue

## 7) Deployment changes

- Add env vars:
  - `REDIS_URL`
  - `ENABLE_BACKGROUND_WORKERS=true` for worker processes
- Run backend as stateless replicas (N>=3)
- Run separate worker dynos/containers for BullMQ consumers
- Keep Worker as edge gateway for chat/session fast path
- Configure health checks on `/health` and alerts on queue lag + Redis failures
