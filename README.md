# KORA

Restaurant point of sale and operations workspace for Indian restaurants. This repository contains the responsive Next.js app, a tenant and outlet scoped Prisma/PostgreSQL model, a five-category Indian restaurant seed, offline browser persistence, and tested billing primitives.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. The demo works without a database. Orders, menu changes, customers, shift state, and pending sync count are stored in browser local storage. The service worker caches the app shell after the first successful visit.

To run PostgreSQL and Redis locally, copy `.env.example` to `.env`, then run:

```powershell
docker compose up -d
npm run db:generate
npm run db:migrate -- --name init
npm run db:seed
```

The seed creates a demo tenant/outlet, Owner/Manager/Cashier/Waiter/Kitchen roles, permissions, five menu categories, and ten Indian menu items. Database connectivity is not required for the browser demo; the health endpoint at `/api/health` reports the active local demo mode.

## What works in the demo

- POS order entry for dine-in, takeaway, and delivery, with table assignment, category/search, quantities, 5% GST, percentage discount, payment recording, and offline persistence.
- Order list and kitchen ticket board with preparation status transitions, table transfer, bill detail, print dialog, and partial balance recording.
- Shift open/close with cash variance, menu availability, adding menu items, customer records, inventory views, team roles, report views, and restaurant settings.
- Browser local storage persistence and an installable service worker that caches the app shell after the first successful online visit. Local-demo records remain on the device; they are not uploaded to the API when connectivity returns.

## Architecture and production integration

The Prisma schema covers tenant/outlet ownership, users and RBAC, menu/pricing, orders/KOTs/bills/payments, shift and audit records, offline sync mutations, customers/loyalty/feedback, inventory/recipes/purchases/wastage, and coupons. Monetary values are stored as integer paise. Authenticated API routes and an authenticated Socket.io service are implemented, but the visible app is still a local demo: it does not sign users in or read/write operational records through Prisma, Redis, or Socket.io. The API sync queue is also not yet connected to the browser's offline records. Production rollout requires those client integrations, migrations against a configured PostgreSQL instance, JWT secret rotation, printer/device validation, and GST invoice-series review for offline terminals.

## API and realtime services

Configure `DATABASE_URL` and `JWT_ACCESS_SECRET` (at least 32 characters) in `.env`. Refresh tokens are random opaque tokens stored as hashes, so no refresh-token signing secret is used. Redis is optional for local development; API auth throttling uses an in-memory fallback, while realtime fan-out uses Redis when configured.

```powershell
npm run dev
npm run realtime:dev
```

The API surface includes register/login/refresh/logout/me, outlet-scoped menu/orders/KOT/table transfer, shift, customer and inventory reads, and bill splitting. Configure the same access-token secret for the Next.js app and realtime service. Use `/api/health` and `http://localhost:4000/health` for process health; neither endpoint proves database connectivity.

## Checks

```powershell
npm run lint
npm test
npm run build
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/kora?schema=public'; npx prisma validate
```

The UI was exercised in a local browser for order entry, GST/discount totals, UPI and partial payments, KOT status changes, table transfer, shift cash variance, menu creation/availability, reload persistence, and the five seeded categories. API authorization/error paths and realtime token rejection were smoke-tested. A PostgreSQL-backed end-to-end run was not possible in the development environment because no database service or Docker runtime was available; dependency advisory lookup was also unavailable when the npm registry request failed.
