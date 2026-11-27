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

The inventory page is outlet-scoped and shows live raw-material balances, reorder status, and estimated value using integer arithmetic. Users with `inventory.adjust` can create ingredients, record an opening stock correction, log wastage, manage the tenant's shared vendor directory, and create/edit/remove recipe BOMs. The recipe editor supports a batch yield and 1–50 unique materials, displays outlet units, and uses cursor-paged menu and recipe lists. The server remains the authorization boundary; hidden controls are only a UX filter.

## Recipe BOMs

- `GET /api/inventory/recipes?outletId=...` requires `inventory.view`; it returns outlet recipes and active menu items assigned to that outlet. Recipe and menu-item cursors are validated against the authorized tenant/outlet before being used.
- `POST /api/inventory/recipes` requires `inventory.adjust` and an explicit `operation` of `create` or `update`. It accepts an outlet menu item, yield (1–10,000 portions), and 1–50 unique ingredient quantities as positive integer milli-units. It atomically writes the BOM and audit entry; a duplicate `create` returns `409` rather than overwriting an existing recipe.
- `DELETE /api/inventory/recipes?outletId=...&menuItemId=...` removes only that outlet's recipe and records the prior BOM in the audit log.
- A recipe is unique per `(outletId, menuItemId)` and has a composite foreign key to that outlet's menu assignment. Removing menu availability cascades that outlet's recipe and BOM; ownership guards prevent changing tenant/outlet keys to move stock ownership across outlets. The migration safely assigns old recipes only when their outlet can be inferred unambiguously; it aborts for ambiguous records rather than guessing. PostgreSQL triggers enforce recipe/menu and ingredient outlet ownership for direct database writes as well as HTTP requests.
- Order creation and item additions now deduct recipe quantities in the same serializable transaction as the order/KOT writes. Material rows are locked in sorted ID order, then updated conditionally; a rejected shortage rolls the entire order mutation back.
- Outlet setting `stockShortagePolicy` defaults to `BLOCK`; a manager with `settings.manage` can explicitly choose `ALLOW_NEGATIVE`. Negative-stock sales retain the negative balance and write a `STOCK_SHORTAGE_ALLOWED` audit event. Missing settings fail closed to `BLOCK`.
- Every `SALE` stock movement references its `OrderItem` and stores the yield, ingredient quantity, and cumulative rounding offset used at sale time. The ledger can therefore calculate a reversal without reading a recipe that may have since changed.
- Voiding an order restores only quantities explicitly in `QUEUED` or `OUT_OF_STOCK` KOT state. `COOKING`, `READY`, and `BUMPED` consumption remains deducted. Missing or incomplete KOT tracking is treated as consumed and recorded in the `ORDER_VOIDED` audit result; missing recipe snapshots are not guessed. Restorations write positive `SALE_REVERSAL` movements in the same void transaction.
- `recipeDeductionsByOrderItem` is a pure domain helper. It aggregates shared materials, sorts repeated menu lines deterministically, rounds cumulative usage upward, and retains enough snapshot data for exact item-level reversal.

## Verification

- `npm run typecheck` and `npm run lint` pass locally. The full suite, with local PostgreSQL, Next.js development API, and Socket.IO development service enabled, reports 73 passed, 0 failed, 0 skipped.
- `tests/inventory-api.test.mjs` ran against the local development API and PostgreSQL using short-lived signed test users. It covers outlet/tenant authorization, permission denial, recipe create/read/update/delete and audit snapshots, invalid cross-outlet recipe ingredients/cursors, ingredient create/duplicate behavior, vendor create/update and invalid GSTIN handling, stock underflow, and concurrent removal.
- `tests/recipe-consumption.test.mjs` covers quantity scaling, cumulative yield rounding, stable per-line allocation snapshots, shared-material aggregation, and invalid quantities. `tests/cloud-pos-flow.test.mjs` covers blocked and explicitly allowed shortages, audit logging, atomic sale deduction, idempotent replay, recipe edits before void, mixed queued/cooking lines, and missing KOT state.

## Still incomplete

- Purchase orders/receipts and vendor-linked stock movements.
- Recipe-linked sale deduction and void reversal are active. Refunds do not automatically restore physical stock; staff must use a separately authorized stock adjustment when goods are actually returned. Unit conversions, cost-per-plate, stock transfer, and purchase/wastage reports remain incomplete.
- Offline inventory mutations and retry/idempotency handling.
- A controlled unit catalog; the current schema stores a short free-form unit label and quantities at 1/1000 of that unit.
