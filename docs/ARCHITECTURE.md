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

Deploy the Next.js app, realtime service and background sync worker as independently monitored processes. PostgreSQL is the source of truth; Redis coordinates shared rate limits and socket broadcasts. Secrets are injected by the deployment platform. Production startup requires applied migrations and readiness checks for required dependencies.

## Current limitations

The visible app has core cloud POS integration, but offline support currently queues order creation only. A local workspace hint stores outlet/user display metadata, cached menu/table snapshots, and pending orders; it stores no access token and only enables local queue creation. The server revalidates authorization and recalculates prices at sync time. Stale prices, availability, payments, or table assignments can leave an order in a conflict state for staff to resolve and retry. Inventory, recipes, reports, subscriptions, aggregator integrations, printer hardware, and several admin surfaces remain incomplete. There is still no committed migration history or production deployment/rollback configuration.
