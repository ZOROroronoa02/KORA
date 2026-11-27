# Changelog

## 2026-11-27

- Hardened KDS offline replay: dependent item versions are persisted before send, committed predecessor commands remain queued until later commands resolve, failed local queue-state writes stop FIFO processing, and lost-response retries preserve the exact idempotent request after restart.
- Surfaced KDS snapshot/action IndexedDB failures and prevented stale outlet refresh responses from replacing the active board. Added KDS replay regressions and recorded a passing 106-test integrated run plus clean production build.
- Upgraded the Dexie database to version 4 with per-outlet timestamp indexes and transactional monotonic enqueue ordering for offline orders and KDS actions; added tests for same-millisecond inserts and device-clock rollback.
- Added `orders.idempotencyPayloadHash` through migration `20261127260000_order_request_idempotency_hash`.
- Bound new order retries to a canonical server-side SHA-256 request identity. Exact sequential and concurrent replays return the original order; payload changes using the same key now fail with HTTP 409.
- Kept pre-migration orders compatible by leaving the new field null and preserving their existing retry behavior.
- Added unit coverage for deterministic request hashing and a PostgreSQL/API regression case for concurrent replay and changed-payload key reuse.
