# Cloud inventory stock workflow

Updated: 2026-11-27.

## API

- `GET /api/inventory?outletId=...` requires `inventory.view` and returns the selected outlet's raw-material balances.
- `POST /api/inventory` requires `inventory.adjust`; the server resolves the user, tenant, outlet assignment, and permission. Client-supplied tenant IDs are ignored.
- `GET /api/inventory/vendors?outletId=...` requires `inventory.view`, returns tenant-shared vendors, and paginates with a bounded limit and cursor. `POST` and `PATCH` require `inventory.adjust`; create/update actions are audited against the outlet context. Vendor GSTIN, email, and phone values are validated server-side.
- `operation: "create"` creates an outlet ingredient at zero stock. The body accepts `name`, `unit`, `reorderMilli`, and optional `costPerUnitPaise`; values are validated as bounded integer strings. Names are unique within an outlet. Creation writes an audit record in the same transaction.
- `operation: "adjust"` applies a signed `quantityMilli` correction. `operation: "wastage"` accepts a positive quantity and a required reason, subtracts stock, writes a stock movement and wastage row, and audits the before/after balance.
- Every stock movement uses a serializable transaction. Insufficient stock, duplicate ingredient names, or serialization races return `409`; no movement or audit is committed on rejection.
- Purchase intake is deliberately not accepted by this endpoint. A vendor purchase must create `Purchase` and `PurchaseLine` records as well as movements; treating a plain stock increment as a purchase would leave the purchasing ledger false.

## Cloud UI

The inventory page is outlet-scoped and shows live raw-material balances, reorder status, and estimated value using integer arithmetic. Users with `inventory.adjust` can create ingredients, record an opening stock correction, log wastage, and manage the tenant's shared vendor directory. The server remains the authorization boundary; hidden controls are only a UX filter.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` pass locally. The full default suite reports 51 passed and 7 database/realtime integration tests skipped when its environment variables are absent.
- `tests/inventory-api.test.mjs` was also run against the local production server and PostgreSQL using a short-lived signed test user. It covers outlet/tenant authorization, permission denial, ingredient create/duplicate behavior, vendor create/update and invalid GSTIN handling, audit snapshots, underflow protection, and concurrent removal.

## Still incomplete

- Vendor CRUD, purchase orders/receipts and vendor-linked stock movements.
- Recipe BOMs, stock deduction on sale, unit conversions, cost-per-plate, stock transfer, and purchase/wastage reports.
- Offline inventory mutations and retry/idempotency handling.
- A controlled unit catalog; the current schema stores a short free-form unit label and quantities at 1/1000 of that unit.
