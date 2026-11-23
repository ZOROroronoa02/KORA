# KORA Architecture

## Current system

KORA currently has a Next.js App Router/TypeScript client with a single large client page, a PostgreSQL/Prisma data model, Next.js API routes, and a separately run Socket.io process. The browser demo persists an aggregate state object in `localStorage`. A service worker caches the application shell. The client does not yet authenticate or use the database APIs; therefore the present UI is a demo, not a cloud POS.

## Target boundaries

- **Web client:** URL-based workspaces, server-backed sessions, offline-safe UI, IndexedDB through Dexie.
- **API:** authenticated route handlers; tenant/outlet context is derived from the user assignment; schemas validate request boundaries; transactions enforce financial invariants.
- **PostgreSQL:** source of truth for tenant, outlet, employees, menu, orders, KOTs, bills, payments, shifts, inventory, sync mutations and audit events.
- **Redis:** distributed rate limiting and Socket.io fan-out; required in production where multiple application processes are used.
- **Realtime:** Socket.io emits notifications only. Mutations remain API transactions and clients refetch authoritative state.
- **Integrations:** explicit adapters for printers, payment gateways, aggregators and messaging. An adapter reports queued/sent/acknowledged/failed and never fabricates provider success.

## Trust boundaries

The browser, offline outbox, external webhooks and device identifiers are untrusted. API code derives tenant identity from verified access tokens and outlet assignment. A client-supplied tenant, outlet, customer, table, price or payment status is never authoritative. Monetary amounts cross API boundaries as integer paise.

## Dependency order

Database ownership constraints and migrations → auth and tenant context → order/payment state machines → shift and audit transactions → API-connected POS → durable offline outbox → inventory/reporting → integrations and subscriptions → production operations.

## Deployment shape

Deploy the Next.js app, realtime service and background sync worker as independently monitored processes. PostgreSQL is the source of truth; Redis coordinates shared rate limits and socket broadcasts. Secrets are injected by the deployment platform. Production startup requires applied migrations and readiness checks for required dependencies.

## Current limitations

The visible app is local demo mode. Socket.io, authenticated APIs and Prisma models are scaffolding and are not yet connected to the browser workflows. No database migration files or production deployment configuration existed at discovery time.
