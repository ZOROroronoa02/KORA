# Changelog

## 2026-11-27

- Added outlet-scoped purchase receipt history/intake with payload-hash idempotency, bounded pagination, active-vendor and material ownership checks, integer-paise totals, moving weighted-average landed cost, purchase movements and atomic audit. Added migration `20261127280000_inventory_purchase_receipts`; negative on-hand stock is treated as an unvalued shortage when calculating the receipt cost average. Added the cloud receipt form/history and retry-same-payload UX. Purchase orders, payables, returns, input-tax-credit accounting, and offline receipt queueing remain out of scope.
- Added domain and PostgreSQL/API concurrency tests for receipt math, tenant/outlet isolation, idempotent retries, serialization conflicts, exact cost/quantity, audit, and cursor paging.
- Hardened `/api/health/ready`: report PostgreSQL/Redis dependency states without connection details, use no-store headers, disable retries, and enforce a 1.5-second overall Redis probe deadline (with one-second connect/socket limits). The local production probe now identifies the actual blocker as `redis: required` while PostgreSQL is ready.
- Added readiness policy, stalled-handshake, and live endpoint tests. Final full suite: 118 passed, 0 failed, 0 skipped; production build, lint/typecheck, and CSP smoke passed. Production mode remains not ready until Redis is provisioned.
- Added cloud shift reconciliation reports with dual-permission and tenant/outlet guards, IST date validation, bounded cursor pagination, grouped ledger totals, open cash estimates, close mismatch detection, and formula-safe export. Non-cash refunds without shift IDs remain in outlet-level reporting rather than being assigned to a cashier retroactively.
- Added migration `20261127280000_inventory_purchase_receipts` for purchase receipt idempotency and tenant/outlet/date pagination; the existing local database now reports all 17 migrations applied.
- Replayed all 17 migrations successfully in a fresh disposable local database and removed that exact database after verification.
- Reused a tested India-local date-range helper for sales and shift reports; added shift-report integration coverage for permissions, outlet/tenant isolation, refund reconciliation, pagination, date errors, and CSV injection safety. Full suite after migration: 110 passed, 0 failed, 0 skipped; production CSP smoke and build passed. Production API readiness remains blocked by local Redis availability.
- Hardened KDS offline replay: dependent item versions are persisted before send, committed predecessor commands remain queued until later commands resolve, failed local queue-state writes stop FIFO processing, and lost-response retries preserve the exact idempotent request after restart.
- Surfaced KDS snapshot/action IndexedDB failures and prevented stale outlet refresh responses from replacing the active board. Added KDS replay regressions and recorded a passing 106-test integrated run plus clean production build.
- Upgraded the Dexie database to version 4 with per-outlet timestamp indexes and transactional monotonic enqueue ordering for offline orders and KDS actions; added tests for same-millisecond inserts and device-clock rollback.
- Added `orders.idempotencyPayloadHash` through migration `20261127260000_order_request_idempotency_hash`.
- Bound new order retries to a canonical server-side SHA-256 request identity. Exact sequential and concurrent replays return the original order; payload changes using the same key now fail with HTTP 409.
- Kept pre-migration orders compatible by leaving the new field null and preserving their existing retry behavior.
- Added unit coverage for deterministic request hashing and a PostgreSQL/API regression case for concurrent replay and changed-payload key reuse.
