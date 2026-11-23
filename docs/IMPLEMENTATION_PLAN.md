# KORA Implementation Checklist

Status: active. `[x]` means implemented and locally verified; `[~]` means partial or verified only without the production dependency; `[ ]` means unfinished.

## Milestone 1 — stabilize the foundation

- [ ] Enforce cross-tenant/outlet reference ownership and database constraints.
- [ ] Guard order/KOT transitions against invalid or concurrent changes.
- [ ] Make idempotent retries return the original committed order.
- [ ] Keep all payment input and aggregation in integer paise; add reversal ledger.
- [ ] Link payments to cashier shifts; make open/close transactional and exclusive.
- [ ] Commit an initial migration and add PostgreSQL integration/concurrency tests.

## Milestone 2 — make the SaaS real

- [ ] Add registration/login/onboarding UI and usable tenant defaults.
- [ ] Connect menu, order, shift and customer UI to authenticated APIs.
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
- [ ] Add CI, migrations deploy, observability, backups/restore and rollback.
- [ ] Run staging acceptance, security, load and launch checks.

## Current verified baseline

- [x] TypeScript typecheck, 13 existing billing/security unit tests, Next production build and Prisma schema validation passed in the local environment.
- [~] Browser demo order/payment/KOT/menu/shift flows were exercised previously; they are not proof of cloud persistence.
- [ ] PostgreSQL-backed integration/concurrency tests are blocked until a database service is available.
