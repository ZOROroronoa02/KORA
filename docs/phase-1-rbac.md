# KORA Phase 1: outlet RBAC and approval controls

## What changed

- Added tenant system roles, a separate global `SUPER_ADMIN` role assignment, per-outlet user role assignments, outlet JSON settings, hashed manager approval PINs, and actor/approver audit relations in Prisma.
- Added exact dot-namespaced permission definitions and defaults for `OWNER`, `RESTAURANT_MANAGER`, `CASHIER`, `WAITER`, `CHEF`, `ACCOUNTANT`, and `INVENTORY_MANAGER`.
- Added server authorization helpers that resolve effective permissions from PostgreSQL/Redis. Access tokens contain the user subject and tenant ID; role and permission claims are never trusted. Outlet permissions use a 30-second cache with invalidation after role or permission edits.
- Guarded existing outlet API reads and writes with specific permissions. Order responses redact totals and line prices for non-billing roles. Existing order, payment, menu-price, shift, stock, role, settings, and approval mutations record audit entries.
- Added manager PIN approval for discounts above the configured outlet threshold and optional order void approval. The approver must be a different active user with the matching approval permission; the audit entry stores their user ID.
- Added role assignment, custom-role cloning/permission editing, effective permission display, audit log filters, outlet approval settings, and local demo role preview.
- Changed realtime sockets to resolve permissions from the database, disconnect when access changes, and join permission-specific rooms. Event publishers no longer broadcast outlet events to every connected outlet user.
- Updated seed data to two outlets, five menu categories, ten menu items per outlet, ten staff profiles, a cashier shift, and six KOT records in queued/preparing/ready states. Non-owner demo users receive random password hashes that are not logged or displayed. Configure `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` only for a local demo login.

## Roles and selected permission defaults

| Role | Default access |
|---|---|
| `OWNER` | All current permissions except `orders.create`; includes roles/outlets administration, reports, billing, audit, inventory, menu, and settings |
| `RESTAURANT_MANAGER` | Outlet operations, orders, bills, shifts, KDS, inventory, staff, customers, and operational reports; no `roles.manage` or `outlets.manage` |
| `CASHIER` | Read/create orders, bills/settlement/split, discount apply, shifts, and menu view; no discount approval or void by default |
| `WAITER` | Read/create/edit orders, table operations, KOT print, and menu view; no `bills.*` permissions |
| `CHEF` | `kds.view`, `kds.bump`, `kds.recall`, `kds.hold` only |
| `ACCOUNTANT` | Read-only `reports.view.*` and `audit.view` |
| `INVENTORY_MANAGER` | `inventory.view` and `inventory.adjust` |
| `SUPER_ADMIN` | Global platform role, assigned separately through `UserPlatformRole`; no tenant membership is implied |

Permission checks are exact matches; values such as `reports.view.*` are not wildcards. The manager’s authority is represented by explicit permission grants. A custom role can be cloned from a system role; system-role grants are locked.

## API authorization map

| API surface | Required permission |
|---|---|
| `GET /api/orders` | One of `orders.read`, `reports.view.sales`, `kds.view`; results are scoped to the outlet and then to the caller’s own orders or kitchen queue where applicable |
| `POST /api/orders` | `orders.create`; discounts additionally require `bills.discount.apply`; recording payment additionally requires `bills.settle` |
| `PATCH /api/orders/:orderId` | `orders.void`, `orders.move_table`, `kds.bump`, or `orders.edit` according to action |
| `POST /api/orders/:orderId/payments` | `bills.settle` |
| `POST /api/bills/:billId/split` | `bills.split` |
| `GET /api/menu`, `POST/PATCH /api/menu` | `menu.view`, `menu.edit`, and/or `menu.price_edit` |
| `GET/POST /api/customers` | `customers.view`, `customers.manage` |
| `GET/POST /api/inventory` | `inventory.view`, `inventory.adjust` |
| `GET/POST /api/shifts` | `shift.open`, `shift.close` |
| `GET/PATCH /api/outlet-settings` | `settings.manage` |
| `GET/POST/PATCH /api/admin/roles` | `roles.manage` |
| `GET/PATCH /api/admin/staff` | `staff.manage` to read; `roles.manage` to assign roles |
| `POST /api/staff/approval-pin` | `bills.discount.approve` or `bills.void` |
| `GET /api/audit` | `audit.view` |

Registration, login, refresh, logout, and health endpoints remain outside outlet RBAC by design. `src/proxy.ts` is Next.js 16 Proxy middleware and continues to apply security headers; it is not treated as the authorization boundary. This checkout is a single Next.js app with in-dashboard page navigation, so page access is filtered by the same exact permissions and displays an in-app no-access state. API authorization remains authoritative.

## Realtime events and access rooms

Existing events remain `order:new`, `order:updated`, `kot:status`, `menu:updated`, and `shift:updated`. Subscribers join `tenant:<tenantId>:outlet:<outletId>:permission:<permission>` rooms. Event mapping:

- `order:new`: `orders.read`, `kds.view`
- `order:updated`: `orders.read`, `kds.view`, `bills.settle`
- `kot:status`: `orders.read`, `kds.view`
- `menu:updated`: `menu.view`
- `shift:updated`: `shift.open`, `shift.close`

Unknown events are not broadcast. A socket is disconnected when its effective outlet permissions change or its access token expires. Realtime security revalidation runs every 30 seconds.

## Database migration and rollback

- `20261126090000_baseline` records the original schema for the pre-existing database without replaying its table creation.
- `20261126100000_phase1_rbac` applies additive schema changes, migrates legacy role and permission keys, seeds built-in roles/grants, and initializes outlet settings. Its DDL is idempotent so an already-updated local database can run the data portion safely.
- A structural `rollback.sql` is included. Prisma Migrate does not provide automatic down migrations. Before rollback, stop writers and restore the database backup; the phase migration intentionally replaces legacy role/permission mappings and the rollback script warns against a blind rollback.

Applied to the local `kora` PostgreSQL database. `prisma migrate status` reports all migrations applied, and a schema-to-database diff is empty.

## Verification run

- `npm run typecheck` — passed.
- `npm run lint` — passed (this repository’s lint script runs `tsc --noEmit`).
- `npx prisma validate` — passed.
- `npx prisma migrate status` — up to date.
- `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --script` — empty migration.
- `npm test` with the local API/database/realtime URLs — 31 passed, 0 failed, 0 skipped. Coverage includes POS flow, cross-outlet customer isolation, concurrent splits, manager PIN approval attribution, waiter financial redaction, permission-cache invalidation, and socket revocation.
- Browser smoke pass on `http://localhost:3000`: the owner dashboard loaded; waiter preview showed floor/order work without billing or settings navigation; cashier preview showed its billing-first workspace; settings access was denied for roles without `settings.manage`.
- Browser permission regression check: the demo role selector stays available when a selected role cannot open Settings; waiter POS hides shift/billing totals and submits as an unpaid kitchen order. The test cart was cleared without creating an order.
- Cloud dashboards show outlet-backed records only; cloud report aggregation displays an unavailable state instead of local demo figures.

## Phase 1 boundaries

The permission catalog includes keys for future actions (`kot.reprint`, `bills.day_close`, `orders.merge`, and others), but this checkout has no matching KOT printer/reprint, day-close, table merge, or full role-aware report endpoints yet. `SUPER_ADMIN` assignment is intentionally separated and has no public tenant-facing assignment API. These require platform-operations decisions or later phases. KDS Phase 2 has not been started; wait for approval before proceeding.

Cloud dashboard pages do not reuse local demo analytics. The cloud overview shows only loaded outlet orders and queued device syncs; customer summaries come from outlet-scoped records; inventory reads the outlet raw-material endpoint. Cloud reports show an explicit unavailable state until bill/payment-aware report aggregation and export endpoints exist. Local demo charts and sample records remain visibly in local demo mode.

The local `.env` has no `REDIS_URL`. Production-mode registration therefore fails closed with HTTP 503 when the Redis-backed auth rate limiter is unavailable; this is expected security behavior, not a skipped guard. The development preview uses the local in-memory limiter. A deployed environment must provide a reachable Redis service before account setup and auth traffic are opened.
