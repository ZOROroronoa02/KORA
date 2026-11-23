# KORA Offline and Sync Design

## Target behavior

Dexie/IndexedDB holds a local operational projection and a durable mutation outbox. A supported mutation is committed locally before the UI confirms it. Each outbox record has stable mutation ID, device ID, outlet context, entity, operation, payload, sequence/version, timestamp, retries and status.

## State model

`LOCAL_ONLY → PENDING → SYNCING → SYNCED`, with terminal/operator states `FAILED` and `CONFLICT`. The client retains records until the API returns an acknowledgement. Retry uses exponential backoff with jitter and a bounded dead-letter path; staff can inspect and retry failures.

## Conflict policy

- Orders/payments: append-only idempotent events; never overwrite a successful payment.
- KOT: conditional state transitions; reject stale transitions and reconcile from server state.
- Menu: server version wins unless a manager resolves the conflict.
- Inventory: stock movements are additive, uniquely identified events; negative-stock policy is explicit.
- Shift close: online-only unless a separately designed signed offline reconciliation policy exists.

## Security

Tenant/outlet IDs in local records are hints only. The server derives and verifies authorization. Offline payment recording means “recorded locally,” never “provider confirmed.” Device IDs are not credentials.

## Current limitations

The current UI stores one aggregate object in localStorage and a separate count. There is no sync API, acknowledgement, conflict handling, or background sync worker. The service worker caches the shell only.
