# KORA Architecture

## Current system

KORA currently has a Next.js App Router/TypeScript client with a large client dashboard, a PostgreSQL/Prisma data model, Next.js API routes, and a separately run Socket.io process. The browser can run in isolated local demo mode or authenticate to a tenant/outlet and use the menu, tables, orders, payments, shifts, customers, and KOT APIs. Demo state remains in `localStorage`; cloud menu snapshots and pending orders use Dexie/IndexedDB. A service worker caches the application shell.

## Target boundaries

- **Web client:** in-memory access tokens, HttpOnly refresh cookie, permission-filtered navigation, offline menu snapshot and order outbox in IndexedDB through Dexie.
- **API:** authenticated route handlers; tenant/outlet context is derived from the user assignment; schemas validate request boundaries; transactions enforce financial invariants.
- **PostgreSQL:** source of truth for tenant, outlet, employees, menu, orders, KOTs, bills, payments, shifts, inventory, sync mutations and audit events.
- **Redis:** distributed rate limiting and Socket.io fan-out; required in production where multiple application processes are used.
- **Realtime:** authenticated Socket.io emits notifications only. Mutations remain API transactions and clients refetch authoritative state; polling recovers missed events and supports deployments without Redis fan-out.
- **Integrations:** explicit adapters for printers, payment gateways, aggregators and messaging. An adapter reports queued/sent/acknowledged/failed and never fabricates provider success.

## Trust boundaries

The browser, offline outbox, external webhooks and device identifiers are untrusted. API code derives tenant identity from verified access tokens and outlet assignment. A client-supplied tenant, outlet, customer, table, price or payment status is never authoritative. Monetary amounts cross API boundaries as integer paise.

## Dependency order

Database ownership constraints and migrations → auth and tenant context → order/payment state machines → shift and audit transactions → API-connected POS → durable offline outbox → inventory/reporting → integrations and subscriptions → production operations.

## Deployment shape

Deploy the Next.js app, realtime service and background sync worker as independently monitored processes. PostgreSQL is the source of truth; Redis coordinates shared rate limits and socket broadcasts. Secrets are injected by the deployment platform. Production startup requires applied migrations and readiness checks for required dependencies. The realtime process refuses to start in production without Redis; `/health/live` is process liveness and `/health/ready` checks PostgreSQL and Redis fan-out connectivity.

## Current limitations

Offline POS can queue order creation with an initial recorded payment, and KDS actions have a separate conditional outbox. A local workspace hint stores outlet/user display metadata, cached menu/table snapshots, and pending orders; it stores no access token. The latest production worker caches the public root shell and hashed JS/CSS only. Local permissions are bounded to 12 hours; the server revalidates authorization and recalculates prices, tax, stock, and shift eligibility at sync time. Stale prices, availability, payment amounts, or shift state can leave a queued order waiting for authorized operator review; there is no edit/reprice conflict-resolution workflow yet. Separate settlement/refunds and shift open/close have no offline queue; there is no Background Sync or durable ESC/POS retry queue. Recipe-linked purchasing, GST exports, subscriptions, aggregator operations, verified printer hardware, and several admin surfaces remain incomplete. SQL migrations include tenant ownership triggers, financial-year invoice sequencing, append-only payments, and tenant-level GST profiles. CI and web/realtime/migrator Docker targets exist; production deployment, rollback automation, observability, and provider-level backup/restore drills remain incomplete. See `docs/OFFLINE_SYNC.md` and `docs/EXECUTION_STATUS.md` for current boundaries.
