# KORA API Contracts

## Common contract

Authenticated APIs accept a bearer access token. Tenant identity comes only from verified token claims and active server-side user records. Outlet actions require a current user-to-outlet role assignment and permission. All amounts are integer paise. JSON is schema-validated; malformed JSON and invalid fields return a consistent `400` response. Errors use `{ "error": { "code": "...", "message": "...", "requestId": "..." } }` in the target contract.

## Existing routes

| Route | Current capability | Target requirements |
|---|---|---|
| `/api/auth/*` | Register, login, refresh, logout, me | Password reset/verification policy, structured errors, integration tests |
| `/api/menu` | Outlet menu read/create/availability-price update | Schema validation, cursor bounds, variants/modifiers and audited changes |
| `/api/orders` | Order list/create with KOT/bill and initial payment | Pagination, customer/table ownership, race-safe idempotency, shift attribution, tax config |
| `/api/orders/:id` | KOT status, table transfer, void | State machine, occupied-table protection, refund workflow, audit transitions |
| `/api/bills/:id/split` | Amount/item allocation | Atomic uniqueness and split payment settlement |
| `/api/shifts` | Open/close cash reconciliation | Exclusive open, linked payments, atomic close and event audit |
| `/api/customers` | Customer read/create | Pagination, consent, outlet ownership, visit/loyalty updates |
| `/api/inventory` | Outlet stock read, ingredient creation, adjustment and wastage | Controlled unit catalog, offline inventory commands |
| `/api/inventory/purchases` | Paginated receipt history; idempotent received-goods intake; atomic stock movement, weighted-average landed cost and audit | Purchase orders, supplier invoice/tax-credit accounting, payments/returns, offline receipts |
| `/api/inventory/vendors` | Tenant-shared vendor directory with outlet authorization | Verified supplier GSTIN lookup and vendor import |
| `/api/health` | Process response | Liveness/readiness separation and dependency checks |

## Idempotency

Every retryable financial mutation carries a stable client mutation ID. The order API persists a server-computed canonical request hash and returns the original result only for an exact replay. Reusing an order mutation ID with a different payload returns `409`. Older orders without a stored hash keep the legacy replay behavior for rollout compatibility. Provider webhooks are verified against raw request bytes and deduplicated by provider event ID.

## Current limitations

The contracts above describe the intended stable boundary. Existing routes have inconsistent response errors and are not yet all schema-validated or consumed by the UI.
