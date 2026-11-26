# KORA Implementation Checklist

Status: active. `[x]` means implemented and locally verified; `[~]` means partial or verified only without the production dependency; `[ ]` means unfinished.

## Milestone 1 — stabilize the foundation

- [x] Enforce cross-tenant/outlet reference ownership and database constraints.
- [x] Guard order/KOT transitions against invalid or concurrent changes.
- [x] Make idempotent retries return the original committed order.
- [~] Keep payment input and aggregation in integer paise; payment reversals/refunds still need an immutable reversal ledger.
- [x] Use exact `BigInt` rounding for GST/service charge and allocate outlet invoices by Indian financial year.
- [x] Link cash payments to cashier shifts; make open/close transactional and exclusive.
- [x] Commit SQL migrations and PostgreSQL integration/concurrency tests.

## Milestone 2 — make the SaaS real

- [x] Add registration/login/onboarding UI and usable tenant defaults.
- [~] Connect menu, order, shift and customer UI to authenticated APIs.
- [ ] Add schema validation and consistent API errors/pagination.

## Milestone 3 — restaurant operations

- [ ] Complete KOT items, incremental tickets, table states, refunds and bill settlement.
- [ ] Implement configurable tax rules and verified invoice export.
- [ ] Implement inventory recipes/purchasing/wastage and transactional deductions.

## Milestone 4 — offline-first

- [ ] Replace aggregate localStorage with Dexie stores and a durable outbox.
- [ ] Add idempotent sync acknowledgements, retry/backoff, conflict and dead-letter flows.
- [ ] Exercise refresh, restart, quota failure and reconnect workflows.

## Milestone 5 — business intelligence

- [ ] Replace all sample metrics with timezone-aware database aggregates.
- [ ] Add cursor pagination, CSV/PDF exports and multi-outlet reporting.

## Milestone 6 — production quality

- [ ] Complete accessibility/mobile testing, printers and external adapters.
- [~] Add CI and migrations deploy; GitHub execution, production deployment, observability, backups/restore and rollback still need verification.
- [ ] Run staging acceptance, security, load and launch checks.

## Current verified baseline

- [x] TypeScript typecheck, Prisma validation, migration status, and Next production build passed locally.
- [x] Full live PostgreSQL/realtime suite passed 48/48; the tenant-ownership migration and direct-write adversarial checks passed.
- [~] Browser demo order/payment/KOT/menu/shift flows were exercised previously; they are not proof of cloud persistence.
- [~] `npm run db:audit-tenant-ownership` found no mismatches in the current local database; production data still needs the same scan before migration rollout.
