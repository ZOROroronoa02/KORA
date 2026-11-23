# KORA Database Design

## Source of truth

PostgreSQL stores financial and operational state. Monetary columns are integer paise (`BigInt`). Stock quantities use integer milli-units. Tenant and outlet ownership must be part of query filters and, for related records, compound database constraints where supported.

## Ownership rules

- `Tenant` owns users, outlets, categories, menu items, customers, recipes, inventory, orders, bills, shifts and audit history.
- Outlet-owned operations must reference an outlet belonging to the same tenant.
- Order `customerId` and `tableId` must be validated against that order's tenant/outlet; a plain FK is not sufficient.
- Payments belong to a bill and a cashier shift. Refunds are additive reversal records, never edits that erase a successful payment.
- Audit events are append-only and include tenant/outlet, actor, entity, before/after, reason and request/device context.

## Invariants to enforce

- Unique order idempotency key per outlet/device namespace.
- Unique order number and invoice number per outlet.
- One open shift per cashier/outlet (or per outlet under an explicitly configured shared-drawer policy).
- One split allocation per bill; split allocations must sum exactly to bill total.
- Stock cannot become negative unless an explicit policy allows it; every change produces a movement row.
- Order, bill, payment, shift and inventory changes commit atomically.

## Indexing and access patterns

Use compound indexes matching tenant/outlet, date, status, cashier and cursor pagination. Query reports with database aggregates. Do not load payment histories merely to sum them in application memory. Paginate customer, order, inventory and audit history.

## Migration policy

Schema changes require reviewed, committed Prisma SQL migrations. Production deploy uses `prisma migrate deploy`, never `migrate dev`. Breaking changes use expand-and-contract migrations. Destructive changes require a verified backup and explicit operational approval.

## Current limitations

The initial Prisma schema validates but no migration history was present at discovery. Some relations use independent `tenantId` and `outletId` fields that do not by themselves enforce matching ownership. Payment is not yet linked to Shift.
