-- Store HSN/SAC classification on menu items and immutable order lines, plus
-- buyer identity/address and place-of-supply snapshots for invoice printing.
CREATE TYPE "TaxCodeKind" AS ENUM ('HSN', 'SAC');

ALTER TABLE "menu_items"
  ADD COLUMN "taxCodeKind" "TaxCodeKind",
  ADD COLUMN "taxCode" TEXT;

ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tax_code_check" CHECK (
  ("taxCodeKind" IS NULL AND "taxCode" IS NULL)
  OR ("taxCodeKind" = 'HSN' AND "taxCode" ~ '^[0-9]{2,8}$')
  OR ("taxCodeKind" = 'SAC' AND "taxCode" ~ '^[0-9]{6}$')
);

ALTER TABLE "order_items"
  ADD COLUMN "taxCodeKindSnapshot" "TaxCodeKind",
  ADD COLUMN "taxCodeSnapshot" TEXT;

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tax_code_snapshot_check" CHECK (
  ("taxCodeKindSnapshot" IS NULL AND "taxCodeSnapshot" IS NULL)
  OR ("taxCodeKindSnapshot" = 'HSN' AND "taxCodeSnapshot" ~ '^[0-9]{2,8}$')
  OR ("taxCodeKindSnapshot" = 'SAC' AND "taxCodeSnapshot" ~ '^[0-9]{6}$')
);

ALTER TABLE "bills"
  ADD COLUMN "recipientNameSnapshot" TEXT,
  ADD COLUMN "recipientGstinSnapshot" TEXT,
  ADD COLUMN "recipientAddressSnapshot" JSONB,
  ADD COLUMN "placeOfSupplySnapshot" TEXT;

UPDATE "bills" AS b
SET "placeOfSupplySnapshot" = o."address" ->> 'state'
FROM "outlets" AS o
WHERE b."outletId" = o."id" AND b."tenantId" = o."tenantId";

-- Down migration (manual/reversible): drop the bill recipient/place-of-supply
-- columns, order-item snapshot constraint and columns, menu tax-code constraint
-- and columns, then drop the TaxCodeKind enum. Historical snapshots are lost.
