# Changelog

## 2026-11-27

- Added `orders.idempotencyPayloadHash` through migration `20261127260000_order_request_idempotency_hash`.
- Bound new order retries to a canonical server-side SHA-256 request identity. Exact sequential and concurrent replays return the original order; payload changes using the same key now fail with HTTP 409.
- Kept pre-migration orders compatible by leaving the new field null and preserving their existing retry behavior.
- Added unit coverage for deterministic request hashing and a PostgreSQL/API regression case for concurrent replay and changed-payload key reuse.
