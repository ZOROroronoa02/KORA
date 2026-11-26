# KORA implementation status

This document records verified implementation state for continuing the KORA build. It is not a production-readiness claim.

## Completed in the current work session

- Added architecture, implementation, database, API, security, offline sync, deployment, and testing design documents under `docs/`.
- Initialized the local Git repository; no commits have been made.
- Added strict rupee-to-paise parsing and order state transition helpers, with unit tests.
- Hardened order creation with tenant/outlet/table validation, idempotency replay, serializable transaction handling, and cash-shift checks.
- Hardened order status, KOT, transfer, void, and shift APIs with conditional updates and transactional audit records.
- Added register-time starter categories, tables, and sample menu data; removed shared default seed credentials.
- Added bounded JSON request parsing to selected API routes.
- Added liveness/readiness endpoints; readiness checks PostgreSQL and production Redis.
- Updated local demo UI to clearly identify demo/offline mode, use paise-safe payment inputs, persist before confirming, and surface browser storage errors.
- Regenerated Prisma Client after finding a stale generated model broke `Shift.activeKey`; verified the isolated database schema has no drift from `schema.prisma`.
- Added authenticated client session handling: access token memory only, refresh cookie session restoration, registration/sign-in/sign-out, and outlet selection.
- Connected cloud POS menu, table occupancy, order list/create, payment collection, shift open/close, customer create/link, menu availability/create, table transfer, and KOT transitions.
- Added a Dexie IndexedDB menu cache and order outbox with stable idempotency IDs, sequential replay, bounded retry backoff, conflict retention, and manual retry.
- Added authenticated Socket.IO event listeners with a polling recovery path.
- Fixed guest metrics so profile creation does not count as a visit; completed idempotent orders update visit/spend once.
- Added a PostgreSQL-backed end-to-end API flow covering account setup/login, menu/tables, shift, order replay, payment replay, KOT, transfer, availability, guest metrics, and reconciliation.

## Verified checks

- TypeScript check passes after the cloud integration edits.
- `npx prisma validate` passes when `DATABASE_URL` is set; the isolated PostgreSQL schema matches the Prisma model.
- Static billing/security suite and opt-in PostgreSQL/realtime integration tests pass individually; the latest full run exposed a serializable order conflict, now addressed with bounded transaction retries. Full rerun is required.
- Browser automation could not initialize in this environment (`trusted Node process exited unexpectedly`); rendered browser QA remains unverified.
- Production migration history, CI/CD, deployment rollback, monitoring, and physical ESC/POS testing remain unverified or missing.

## Remaining work — do not mark complete

1. Complete the full test rerun and production build, then restore the local preview.
2. Create and verify a reviewed initial PostgreSQL migration; `db push` is currently development-only.
3. Audit/fix cross-tenant composite reference constraints and remaining API authorization gaps.
4. Add offline tests for browser reload, replay, conflict repair, duplicate tabs, and connectivity transitions; complete rendered accessibility/mobile QA.
5. Finish incremental KOT additions, void/refund approval, split-bill settlement, menu variants/add-ons, and printer flows.
6. Implement inventory/recipes/purchasing, reporting/GST export, customer loyalty, subscriptions, aggregator adapters, and owner multi-outlet command center.
7. Complete deployment/rollback, monitoring, backup/restore, and acceptance checklist.

Production launch remains blocked until the remaining work is completed and verified in a configured PostgreSQL/Redis deployment environment.
