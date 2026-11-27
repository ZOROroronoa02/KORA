# Cloud inventory stock workflow

Updated: 2026-11-27.

## API

- `GET /api/inventory?outletId=...` requires `inventory.view` and returns the selected outlet's raw-material balances.
- `POST /api/inventory` requires `inventory.adjust`; the server resolves the user, tenant, outlet assignment, and permission. Client-supplied tenant IDs are ignored.
- `GET /api/inventory/vendors?outletId=...` requires `inventory.view`, returns tenant-shared vendors, and paginates with a bounded limit and cursor. `POST` and `PATCH` require `inventory.adjust`; create/update actions are audited against the outlet context. Vendor GSTIN, email, and phone values are validated server-side.
- `operation: "create"` creates an outlet ingredient at zero stock. The body accepts `name`, `unit`, `reorderMilli`, and optional `costPerUnitPaise`; values are validated as bounded integer strings. Names are unique within an outlet. Creation writes an audit record in the same transaction.
- `operation: "adjust"` applies a signed `quantityMilli` correction. `operation: "wastage"` accepts a positive quantity and a required reason, subtracts stock, writes a stock movement and wastage row, and audits the before/after balance.
- Every stock movement uses a serializable transaction. Insufficient stock, duplicate ingredient names, or serialization races return `409`; no movement or audit is committed on rejection.
- `GET /api/inventory/purchases?outletId=...` requires `inventory.view` and returns a bounded, newest-first, cursor-paged receipt history. Cursors must belong to the selected outlet.
- `POST /api/inventory/purchases` requires `inventory.adjust`. It accepts a `clientMutationId` UUID, optional active tenant vendor and reference, and 1–100 unique outlet ingredients with positive `quantityMilli` and non-negative `unitCostPaise`. A landed unit cost is per stock unit and includes non-creditable taxes/charges; the API computes line and receipt totals in integer paise and never trusts a client total.
- A receipt commits `Purchase`, `PurchaseLine`, `PURCHASE` stock movements, quantity changes, weighted-average unit cost, and one audit snapshot in the same serializable transaction. Ingredient rows are locked in sorted ID order. If an outlet permits negative stock, a deficit contributes no inventory value to the moving average; a receipt's landed cost is used until the on-hand balance is positive.
- The purchase request ID and a canonical payload hash are unique per outlet. Exact retries return the saved receipt without applying stock twice; reuse with changed quantities, materials, vendor, or costs returns `409`. A concurrent stock serialization conflict returns a retryable `409` and leaves no partial rows.
- Purchase intake is no longer accepted as a plain stock adjustment. `POST /api/inventory` still rejects `operation: "purchase"`; received goods must use the receipt ledger route.

## Cloud UI

The inventory page is outlet-scoped and shows live raw-material balances, reorder status, and estimated value using integer arithmetic. Users with `inventory.adjust` can create ingredients, record an opening stock correction, log wastage, manage the tenant's shared vendor directory, receive stock, and create/edit/remove recipe BOMs. Receipt retries remain locked to the same request body until confirmed. Receipt history and vendor/recipe lists are paginated. The recipe editor supports a batch yield and 1–50 unique materials, displays outlet units, and uses cursor-paged menu and recipe lists. The server remains the authorization boundary; hidden controls are only a UX filter.

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

- `npm run typecheck`, `npm run lint`, and the production build pass locally. Fresh replay of all 17 migrations succeeded in a disposable local database. The full suite, with local PostgreSQL, Next.js development API, and Socket.IO development service enabled, reports 118 passed, 0 failed, 0 skipped.
- `tests/inventory-api.test.mjs` and `tests/inventory-purchases-api.test.mjs` run against the local development API and PostgreSQL using short-lived signed test users. They cover outlet/tenant authorization, permission denial, recipe CRUD and audits, cross-outlet ingredient/cursor rejection, vendor validation, stock underflow, concurrent removal, purchase idempotency, changed-payload rejection, weighted cost, receipt pagination, audit/movement atomicity, and same-key/different-key concurrent receipt races.
- `tests/recipe-consumption.test.mjs` covers quantity scaling, cumulative yield rounding, stable per-line allocation snapshots, shared-material aggregation, and invalid quantities. `tests/cloud-pos-flow.test.mjs` covers blocked and explicitly allowed shortages, audit logging, atomic sale deduction, idempotent replay, recipe edits before void, mixed queued/cooking lines, and missing KOT state.

## Still incomplete

- Purchase orders and accounts-payable workflow. The current receipt endpoint records only goods already received; it does not represent ordered, invoiced, paid, returned, or tax-credit states.
- Recipe-linked sale deduction and void reversal are active. Refunds do not automatically restore physical stock; staff must use a separately authorized stock adjustment when goods are actually returned. Unit conversions, cost-per-plate, stock transfer, and purchase/wastage reports remain incomplete. Offline inventory receipts are not queued.
- Offline inventory mutations and retry/idempotency handling.
- A controlled unit catalog; the current schema stores a short free-form unit label and quantities at 1/1000 of that unit.
