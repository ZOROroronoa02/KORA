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
| `/api/inventory` | Stock read and adjustment/purchase/wastage movement | Recipe/purchase workflows, request schema, transactional valuation |
| `/api/health` | Process response | Liveness/readiness separation and dependency checks |

## Idempotency

Every retryable financial mutation carries a stable client mutation ID. The API persists the mutation result and returns that same result on replay. Conflicting reuse with a different payload is rejected. Provider webhooks are verified against raw request bytes and deduplicated by provider event ID.

## Current limitations

The contracts above describe the intended stable boundary. Existing routes have inconsistent response errors and are not yet all schema-validated or consumed by the UI.
