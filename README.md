# KORA

KORA is a restaurant point of sale and operations workspace for Indian restaurants. It includes a tenant and outlet scoped Next.js/Prisma app, authenticated cloud POS flows, a five-category starter menu, an IndexedDB order outbox, and billing primitives tested in paise.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. The local demo works without a database. Use **Connect cloud** to sign in or create a restaurant account when PostgreSQL and a JWT secret are configured.

To run PostgreSQL and Redis locally, copy `.env.example` to `.env`, then run:

```powershell
docker compose up -d
npm run db:generate
npx prisma db push
npm run db:seed
```

The seed creates a demo tenant/outlet, Owner/Manager/Cashier/Waiter/Kitchen roles, permissions, ten tables, five menu categories, and ten Indian menu items. Set `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` before seeding if you need a demo login; the seed refuses to use shared default credentials. This repository still has no committed migration history: `db push` is for local development only, and production deployment remains blocked on reviewed migrations.

## What works

- Demo mode: sample POS, local order/menu/customer/shift state, browser reload persistence, and cached app shell. Demo records remain separate from cloud records.
- Cloud mode: tenant sign-up/sign-in, short-lived access token held in memory, HttpOnly refresh cookie, outlet selection, live menu and table reads, item availability, menu item creation, customers, shifts, dine-in/takeaway/delivery orders, discounts subject to RBAC, payment recording, idempotent payment retry, table transfer, and KOT status changes.
- Offline cloud mode: cached outlet menu, table snapshot, and orders queued in IndexedDB with stable mutation IDs. After a network loss, a minimal local workspace hint can reopen the POS without storing an access token; it exposes only order creation and cached data. Orders sync sequentially when connectivity returns; transient failures use bounded backoff, while permanent conflicts wait for an explicit retry. A price/availability/table conflict must be resolved before retrying.
- Live updates use authenticated Socket.IO when the realtime service and Redis fan-out are configured, with periodic refresh as a recovery path.

## Architecture and production integration

The Prisma schema covers tenant/outlet ownership, users and RBAC, menu/pricing, orders/KOTs/bills/payments, shift and audit records, offline sync mutations, customers/loyalty/feedback, inventory/recipes/purchases/wastage, and coupons. Monetary values are stored as integer paise. The browser is connected to core cloud endpoints; inventory, recipes, purchasing, reports, subscriptions, aggregator integrations, and several settings screens are still prototype surfaces. The offline workspace hint is not an authorization credential: the server revalidates every queued order after reconnection. Offline orders are repriced by the server at sync time, so staff must resolve changed-price conflicts before settlement. Production rollout still needs committed SQL migrations, deployment/rollback automation, hardware printer validation, and invoice-series review for offline terminals.

## API and realtime services

Configure `DATABASE_URL`, a fresh 32-byte base64url `JWT_ACCESS_SECRET`, `KORA_APP_ORIGIN`, and `KORA_PROXY_SHARED_SECRET` in `.env`. Production also requires Redis and a trusted edge that signs the client IP headers as described in `docs/DEPLOYMENT.md`. Refresh tokens are random opaque tokens stored as hashes, so no refresh-token signing secret is used. Redis is optional for local development; API auth throttling uses an in-memory fallback, while realtime fan-out uses Redis when configured.

```powershell
npm run dev
npm run realtime:dev
```

The API surface includes register/login/refresh/logout/me, outlet-scoped menu/orders/payments/KOT/table transfer, shifts, customers, inventory reads, and bill splitting. Configure the same access-token secret for the Next.js app and realtime service. Use `/api/health` and `http://localhost:4000/health` for process health; neither endpoint proves database connectivity.

## Checks

```powershell
npm run lint
npm test
npm run build
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/kora?schema=public'; npx prisma validate
```

To enable PostgreSQL API tests, also set `KORA_SECURITY_TEST_URL=http://localhost:3000` and `KORA_SECURITY_TEST_REALTIME_URL=http://localhost:4000` in the same shell before `npm test`. Without these values, database and Socket.IO integration tests are reported as skipped. The isolated development run covers auth, outlet isolation, idempotent orders/payments, KOT transitions, table transfer, menu availability, customer metrics, and shift reconciliation. A rendered browser QA pass and physical ESC/POS printer test are still outstanding.
