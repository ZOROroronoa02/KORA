# KORA

KORA is a restaurant point of sale and operations workspace for Indian restaurants. It includes a tenant and outlet scoped Next.js/Prisma app, authenticated cloud POS flows, a five-category starter menu, an IndexedDB order outbox, and billing primitives tested in paise.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. The local demo works without a database. Use **Connect cloud** to sign in or create a restaurant account when PostgreSQL and a JWT secret are configured.

For a production-mode smoke check, run `npm run build` and then `npm run start`. The start script launches Next.js's generated standalone server, matching the repository's `output: "standalone"` configuration.

To run PostgreSQL and Redis locally, copy `.env.example` to `.env`, then run:

```powershell
docker compose up -d
npm run db:generate
npm run db:migrate:deploy
npm run db:seed
```

The seed creates a demo tenant/outlet, Owner/Manager/Cashier/Waiter/Kitchen roles, permissions, ten tables, five menu categories, and ten Indian menu items. Set `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` before seeding if you need a demo login; the seed refuses to use shared default credentials. SQL migrations are committed under `prisma/migrations`; production uses `prisma migrate deploy`, never `db push`.

## What works

- Demo mode: sample POS, local order/menu/customer/shift state, browser reload persistence, and cached app shell. Demo records remain separate from cloud records.
- Cloud mode: tenant sign-up/sign-in, short-lived access token held in memory, HttpOnly refresh cookie, outlet selection, live menu and table reads, item availability, menu item creation, customers, shifts, dine-in/takeaway/delivery orders, discounts subject to RBAC, payment recording, idempotent payment retry, table transfer, and KOT status changes.
- Offline cloud mode: cached outlet menu, table snapshot, and orders queued in IndexedDB with stable mutation IDs. After a network loss, a minimal local workspace hint can reopen the POS without storing an access token; it exposes only order creation and cached data. Orders sync sequentially when connectivity returns; transient failures use bounded backoff, while permanent conflicts wait for an explicit retry. A price/availability/table conflict must be resolved before retrying.
- Live updates use authenticated Socket.IO when the realtime service and Redis fan-out are configured, with periodic refresh as a recovery path.

## Architecture and production integration

The Prisma schema covers tenant/outlet ownership, users and RBAC, menu/pricing, orders/KOTs/bills/payments, shift and audit records, offline sync mutations, customers/loyalty/feedback, inventory/recipes/purchases/wastage, and coupons. Monetary values are stored as integer paise. GST and service-charge rounding use integer arithmetic. The browser is connected to core cloud endpoints; inventory, recipes, purchasing, reports, subscriptions, aggregator integrations, and several settings screens are still incomplete. The offline workspace hint is not an authorization credential: the server revalidates every queued order after reconnection. Offline orders are repriced by the server at sync time, so staff must resolve changed-price conflicts before settlement. GitHub Actions CI and web/realtime/migrator Docker targets are configured but have not yet been run in GitHub or a clean Linux Docker host. Production rollout still needs deployment/rollback automation, backup/restore verification, hardware printer validation, and invoice-series review for offline terminals.

## API and realtime services

Configure `DATABASE_URL` with a restricted runtime database account, `MIGRATION_DATABASE_URL` only in the deploy job, a fresh 32-byte base64url `JWT_ACCESS_SECRET`, `KORA_APP_ORIGIN`, and `KORA_PROXY_SHARED_SECRET` in the appropriate secret stores. Production also requires Redis and a trusted edge that signs the client IP headers as described in `docs/DEPLOYMENT.md`. Refresh tokens are random opaque tokens stored as hashes, so no refresh-token signing secret is used. Redis is optional for local development; production auth throttling and realtime fan-out require shared Redis.

```powershell
npm run dev
npm run realtime:dev
```

The API surface includes register/login/refresh/logout/me, outlet-scoped menu/orders/payments/KOT/table transfer, shifts, customers, inventory reads, and bill splitting. Configure the same access-token secret for the Next.js app and realtime service. Use `/api/health/live` and `/health/live` for process liveness, and `/api/health/ready` and `/health/ready` for dependency readiness. Production realtime startup requires Redis; its readiness check verifies PostgreSQL and Redis fan-out connectivity.

## Checks

```powershell
npm run lint
npm test
npm run build
npm run db:audit-tenant-ownership
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/kora?schema=public'; npx prisma validate
```

To enable PostgreSQL API tests, also set `KORA_SECURITY_TEST_URL=http://localhost:3000` and `KORA_SECURITY_TEST_REALTIME_URL=http://localhost:4000` in the same shell before `npm test`. Without these values, database and Socket.IO integration tests are reported as skipped. The integration suite covers auth, cross-tenant/outlet isolation, database ownership triggers, idempotent orders/payments, KOT transitions, table transfer, menu availability, customer metrics, bill splits, and shift reconciliation. The `lint` script currently runs TypeScript checking only; it is not a separate ESLint pass. A rendered browser QA pass and physical ESC/POS printer test are still outstanding.
