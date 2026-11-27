# KORA acceptance test matrix

This is an execution checklist, not evidence that the cases have passed. Run against a disposable PostgreSQL database and a browser build connected to the same API. Record build SHA, browser/device, database version, and results with each run.

## Static checks

| Check | Required evidence | Failure condition |
|---|---|---|
| TypeScript and lint | `npm run lint` and `npm run typecheck` exit 0 | Any compile/type error |
| Production build | `npm run build` exit 0 | Build failure or missing route chunk |
| Unit suite | `npm test` exit 0 with test count | Failed test or skipped critical billing test |
| Offline permission policy | `tests/offline-permissions.test.mjs` covers the 12-hour permission and open-shift snapshot boundaries, closed/unknown shifts, and unknown permission keys | Expired/future snapshots grant actions or unknown claims survive filtering |
| Prisma schema | `npx prisma validate` and generated client in sync | Invalid relations, stale client, or migration drift |
| Migration reproducibility | Empty disposable DB migrates to current schema | Migration fails or `migrate diff` reports drift |
| API authorization scan | Every tenant route resolves tenant/outlet from authenticated membership | Any caller-controlled tenant ID is trusted without membership validation |
| Monetary arithmetic scan | Amounts are integer paise or fixed-precision database decimals | Floating-point totals or implicit rounding in billing path |
| Offline queue scan | Queue entries have stable operation IDs, tenant/outlet scope, retry policy, and conflict outcome | A retry can create duplicate orders/payments or silently discard a conflict |
| Dependency/config scan | Required secrets are environment supplied; production fails closed | Default credentials, secret in source, or demo auth reachable in production |

## Phase 1 dynamic workflows

| ID | Scenario | Expected result |
|---|---|---|
| POS-01 | Create dine-in order with two items, variant, add-on, and note | Correct prices and quantity snapshots persist; one initial KOT is created; table becomes occupied |
| POS-02 | Add an item after the first KOT was sent | Only newly added/changed unsent items appear on a follow-up KOT; original ticket remains auditable |
| POS-03 | Remove/void an item before and after KOT send | Before send, item disappears from ticket; after send, a cancellation/void instruction is recorded and audit reason is mandatory |
| POS-04 | Send same create request twice with same idempotency key | One order, one bill, one initial KOT, and one payment at most; replay returns the original result |
| POS-05 | Send same request with a different key | A separate order is created only when business validation allows it |
| POS-06 | Two terminals claim the same table simultaneously | One transaction succeeds; the other receives a clear conflict; no duplicate active table occupancy |
| POS-07 | Transfer order to an occupied or cross-outlet table | Transfer is rejected; original order/table remains unchanged |
| POS-08 | Apply 5% GST, service charge, percentage and fixed discount | Displayed subtotal/tax/discount/rounding exactly matches persisted bill to the paise |
| POS-09 | Pay cash, card, or UPI; then retry payment request | Method and paid/pending/partial state are correct; retries do not double charge or double-record payment |
| POS-10 | Try negative amount, zero amount, overpayment, over-precision rupees, and unsafe integer | Invalid amounts reject before mutation; allowed partial payments update due correctly |
| POS-11 | Split bill by item and by amount, then settle all splits | Split totals equal original bill; no item or payment is lost or charged twice |
| POS-12 | Cancel a fully paid order | Cancellation is blocked unless a refund workflow reverses payment and records approval/audit trail |
| POS-13 | Open two shifts for same cashier/outlet from separate terminals | Only one active shift exists; competing open receives conflict |
| POS-14 | Cashier closes shift while a cash payment is being recorded | Transaction ordering is deterministic; close total includes all accepted shift payments exactly once |
| POS-15 | Browser storage is unavailable or quota is exceeded in demo mode | UI shows failure and does not claim order/payment/shift was saved |
| POS-16 | Refresh, lose network, and reopen local POS | Local demo data is recovered; the UI labels it local demo data and never claims server sync |
| POS-17 | Print to available ESC/POS printer and printer disconnected | Correct receipt prints when connected; disconnection produces actionable retry/fallback state without marking a duplicate sale |
| POS-18 | Keyboard-only and Android touch operation at 360px, 768px, and 1280px | Primary order/pay actions are keyboard reachable; controls meet touch target size; no clipped cart/payment actions |
| POS-19 | Refund part of a payment, retry its mutation ID, race two refunds for the remaining balance, and void after full reversal | One immutable refund ledger entry per committed mutation; duplicate retries replay; total reversals never exceed captured payment; partial funds block void; full reversal updates bill/shift state and allows audited void |
| POS-20 | Cloud POS loses connectivity, queues an order with a recorded payment, prints receipt/KOT, restarts within 12 hours, then reconnects with a revoked role or stale menu price | UI shows provisional state and uses only fresh cached permissions; offline cash requires a recent same-user/outlet open-shift snapshot; shift open/close remains online-only; server re-authorizes; rejected commands remain visible and retriable by an authorized operator; no final tax invoice is printed before server sync |

## Cross-tenant, security, and reliability workflows

| ID | Scenario | Expected result |
|---|---|---|
| SEC-01 | User from tenant A requests tenant B order/menu/customer/outlet IDs | Uniform authorization denial; no data mutation and no information leak in error body |
| SEC-02 | User has role without discount, void, shift-close, or menu-edit permission | Corresponding mutation is denied server-side, regardless of hidden UI controls |
| SEC-03 | Cashier attempts discount/void above configured threshold | Action waits for authorized manager approval and records actor, approver, reason, and before/after values |
| SEC-04 | Submit malformed JSON, oversized body, missing fields, unknown enum, and SQL-like strings | Controlled 4xx response; no stack trace, partial write, or unexpected query behavior |
| SEC-05 | Spoof X-Forwarded-For against rate-limited endpoint | Client cannot evade rate limits unless trusted proxy is configured to overwrite the trusted header |
| SEC-06 | Expired, revoked, reused refresh token and concurrent refresh | Expired/revoked tokens fail; rotation prevents replay; concurrent use has deterministic outcome |
| SEC-07 | Break Redis in staging and production modes | Development degradation is explicit; production readiness fails and rate-limit/session policy fails closed as configured |
| SEC-08 | Restart API during an order transaction | Either full transaction commits once or no order/bill/KOT/payment mutation commits |
| SEC-09 | Replay offline events out of order and with duplicate IDs | Server deduplicates; dependency/conflict is surfaced; committed sales are not silently overwritten |
| SEC-10 | Clock skew, timezone boundary, and GST day-close | Sales map to outlet timezone and reporting day consistently; timestamps remain UTC in storage |

## Future phase gates

- Inventory: concurrent stock deductions cannot oversell silently; recipe unit conversion and wastage are auditable.
- QR ordering: unauthenticated public menu exposes only publishable data; payment callback is signed and idempotent.
- CRM: phone normalization is deterministic; loyalty earn/redeem is transactionally idempotent.
- Reports: totals reconcile to bills/payments; tenant/outlet filters are enforced; large exports stream or paginate.
- Multi-outlet: centralized menu push has preview, per-outlet override policy, partial failure report, and retry.
- Subscriptions: entitlement checks are server-side; upgrade/downgrade and payment webhooks are idempotent.

## Current execution status

As of 2026-11-27, the current local checkout passed `npm run lint`, `npm run build`, Prisma validation, a fresh-database replay of all 14 migrations, and the environment-backed PostgreSQL/API/realtime/production-CSP suite (91 passed, 0 failed, 0 skipped). The suite exercises refund idempotency, over-refund rejection, concurrent balance protection, service-charge GST and invoice reconciliation, HSN/SAC and buyer snapshots, invoice serial length, tenant/RBAC denial, append-only database triggers, cash reconciliation, POS/KDS, and service-worker cache isolation. A direct local PostgreSQL role check confirmed a temporary DML-only role could read application data but could not disable the order tenant trigger; no staging role was tested. Realtime permission revocation used the development in-memory adapter; Redis-backed production fan-out and multi-instance behavior remain unverified. Chrome on the standalone production build confirmed an authenticated POS workspace, cached outlet/menu, and bounded permission snapshot survive offline hard reload and reconnect. This does not cover full offline sale replay after restart, accessibility/device matrix, invoice printing, or physical printer behavior. Docker is unavailable on the local host, and GitHub Actions has not been run. See `docs/EXECUTION_STATUS.md` for exact release blockers.
