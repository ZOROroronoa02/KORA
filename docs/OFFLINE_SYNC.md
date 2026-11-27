# KORA Offline and Sync Design

## Current implementation

The browser uses Dexie/IndexedDB database `kora-pos-offline-v1` (schema version 3). It stores outlet menu/table snapshots, a minimal offline workspace hint, pending POS order creations, KDS ticket snapshots, and queued KDS actions. Local data is a device cache; it is not an authorization source for server APIs.

### POS order outbox

- An offline order is written to IndexedDB before the UI clears the cart. The mutation has a stable `clientMutationId`, a device ID, outlet hint, creation time, and a display snapshot. Storage failure keeps the cart open and warns the cashier.
- On reconnect and after a cloud session is restored at page startup, the browser submits queued orders in creation order. One outlet queue sync runs at a time. A delayed or rejected earlier order blocks later orders until it is retried or resolved. Transient failures retry with exponential backoff up to five minutes; 4xx failures remain in the outbox with a manual retry action. The queue is retained until the API acknowledges the order.
- The server scopes the request from the authenticated user, verifies outlet permissions, re-reads menu prices/tax/availability and applies stock policy in the order transaction. The outlet/idempotency unique key prevents duplicate orders on retry. A queued initial payment is recorded in the same transaction as the order; it is a local record, not provider confirmation. Cash collection is available offline only when the same user/outlet has a server-verified open-shift snapshot less than 12 hours old; shift opening and closing remain online-only. The server rechecks the shift during sync. Additional payments, refunds, table transfers, and item additions are online-only.
- Changed prices/tax, unavailable menu items, stock shortages, missing buyer/address data, or a closed cash shift can reject the queued command. The command stays visible for manual retry, but there is no edit/reprice conflict-resolution workflow yet. Do not silently discard or alter a queued payment.
- While an order is still unsynced, the UI can print a provisional customer receipt and an offline kitchen ticket. The customer receipt is explicitly not a GST tax invoice and carries no server invoice serial. After successful sync, the server-issued bill/invoice becomes available for printing.

### Kitchen outbox

- The KDS stores the latest ticket snapshot for up to 24 hours and optimistically applies queued item/ticket actions while offline or disconnected from Socket.IO.
- Actions are submitted in creation order with stable mutation IDs and expected item versions. The server checks outlet permission, ticket ownership, request replay, and state transition under a row lock. Stale state conflicts remain in the local queue and appear in the reconnect banner; the operator can discard conflicted actions.
- Reconnect fetches the current server ticket snapshot. Socket events are hints; the API snapshot is the source of truth.

### Authentication boundary

The offline workspace hint contains user/outlet display metadata and the last server-verified permissions, but no access token. A valid permission snapshot may drive the local UI for at most 12 hours. Startup can restore this workspace when the browser is offline or the auth endpoint is unreachable; an explicit auth rejection does not restore it. Cash settlement additionally requires a separate, matching user/outlet open-shift snapshot that is also less than 12 hours old; a newer login/permission refresh does not extend the shift snapshot. At expiry, the UI disables protected actions; it does not invent fallback permissions. Unknown cached permission keys are discarded. This is a usability allowance only: IndexedDB can be edited by the device user, so every protected API request still resolves the current user, outlet, plan, shift, and permissions from the server. On reconnect, pending actions remain provisional until the server re-authorizes and acknowledges them. A revoked user may queue while disconnected, but the server rejects the action during sync and the queue remains for review.

## Not implemented or not verified

- The service worker uses network-first GET handling for the public root shell and hashed Next static JS/CSS assets; API responses, private document responses, and mutations are never cached or intercepted. It falls back to the cached root shell for a navigation while disconnected. In development, the app unregisters old workers and clears only KORA shell caches because Next dev chunk URLs are mutable. Production cache names use a KORA-specific versioned namespace and activation leaves other origin caches alone. There is no Background Sync worker; POS order sync depends on the open page's reconnect event and startup restore. Initial payment can be recorded with an offline order, but separate payment settlement/refund actions have no offline queue. There is no operator workflow to correct stale-price/payment conflicts.
- Browser print layouts support a provisional receipt and local KOT preview, but a durable ESC/POS print queue, printer reconnection/retry, printer failure alerting, and physical 58/80 mm hardware are not verified.
- Menu edits are online-only. There is no offline command batching, sync status history/export, or automated recovery for browser storage eviction, quota exhaustion, device-clock changes, or a long-lived disconnected shift.
- Offline permissions can become stale after a user is disabled or a role changes. The local allowance is capped at 12 hours, but the device cannot learn a revocation while disconnected. The server rejects unauthorized queued commands on reconnect.

## Target conflict policy

- Order creation: append-only and idempotent; server recalculates price, tax, stock, and payment state. Preserve rejected commands for operator resolution.
- Payment: append-only and idempotent; never overwrite a captured payment. Provider settlement must be separately represented when a gateway is integrated.
- KOT: conditional item/ticket state transitions; reject stale transitions and reconcile from the current server snapshot.
- Menu: server version wins and surfaces a conflict for review.
- Inventory: uniquely identified stock-movement events; per-outlet negative-stock policy applies on server sync.
- Shift close: online-only until a signed offline reconciliation policy is designed and tested.
