-- Centralize GST identity at the tenant level and snapshot the selected tax profile
-- and supplier details on every bill. Existing tenant/outlet GSTIN conflicts must
-- be cleaned up before applying this migration; it intentionally fails closed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "outlets"
    WHERE "gstin" IS NOT NULL AND length(btrim("gstin")) > 0
    GROUP BY "tenantId"
    HAVING count(DISTINCT upper(btrim("gstin"))) > 1
  ) THEN
    RAISE EXCEPTION 'GST profile migration blocked: a tenant has multiple outlet GSTINs. Resolve the conflicting registrations before migrating.';
  END IF;

  IF EXISTS (
    SELECT upper(btrim("gstin"))
    FROM "outlets"
    WHERE "gstin" IS NOT NULL AND length(btrim("gstin")) > 0
    GROUP BY upper(btrim("gstin"))
    HAVING count(DISTINCT "tenantId") > 1
  ) THEN
    RAISE EXCEPTION 'GST profile migration blocked: a GSTIN is assigned to multiple tenants. Resolve the duplicate registration before migrating.';
  END IF;
END $$;

CREATE TYPE "GstProfile" AS ENUM ('NOT_REGISTERED', 'STANDARD_RESTAURANT', 'SPECIFIED_PREMISES', 'COMPOSITION');
CREATE TYPE "InvoiceDocumentType" AS ENUM ('RECEIPT', 'TAX_INVOICE', 'BILL_OF_SUPPLY');

-- Existing tenants keep the current 5% regular restaurant behavior. New tenants
-- default to no GST collection until their registration and profile are configured.
ALTER TABLE "tenants"
  ADD COLUMN "gstin" TEXT,
  ADD COLUMN "gstProfile" "GstProfile" NOT NULL DEFAULT 'STANDARD_RESTAURANT',
  ADD COLUMN "gstRateBps" INTEGER NOT NULL DEFAULT 500;

UPDATE "tenants" AS t
SET "gstin" = registrations."gstin"
FROM (
  SELECT "tenantId", max(upper(btrim("gstin"))) AS "gstin"
  FROM "outlets"
  WHERE "gstin" IS NOT NULL AND length(btrim("gstin")) > 0
  GROUP BY "tenantId"
) AS registrations
WHERE registrations."tenantId" = t."id";

CREATE UNIQUE INDEX "tenants_gstin_key" ON "tenants"("gstin");
ALTER TABLE "tenants" ALTER COLUMN "gstProfile" SET DEFAULT 'NOT_REGISTERED';
ALTER TABLE "tenants" ALTER COLUMN "gstRateBps" SET DEFAULT 0;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_gstRateBps_check" CHECK ("gstRateBps" BETWEEN 0 AND 10000);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_gstProfile_rate_check" CHECK (
  ("gstProfile" IN ('NOT_REGISTERED', 'COMPOSITION') AND "gstRateBps" = 0)
  OR "gstProfile" IN ('STANDARD_RESTAURANT', 'SPECIFIED_PREMISES')
);

-- Existing 5% values were the schema default and become inherited profile rates.
-- Non-default per-item rates remain explicit overrides.
ALTER TABLE "menu_items" ALTER COLUMN "gstBps" DROP DEFAULT;
ALTER TABLE "menu_items" ALTER COLUMN "gstBps" DROP NOT NULL;
UPDATE "menu_items" SET "gstBps" = NULL WHERE "gstBps" = 500;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_gstBps_check" CHECK ("gstBps" IS NULL OR "gstBps" BETWEEN 0 AND 10000);

-- Backfill historical bills with the current best available supplier data. Bills
-- created after this migration snapshot these values transactionally at issue time.
ALTER TABLE "bills"
  ADD COLUMN "documentType" "InvoiceDocumentType" NOT NULL DEFAULT 'TAX_INVOICE',
  ADD COLUMN "gstProfile" "GstProfile" NOT NULL DEFAULT 'STANDARD_RESTAURANT',
  ADD COLUMN "gstRateBpsSnapshot" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "gstinSnapshot" TEXT,
  ADD COLUMN "supplierNameSnapshot" TEXT,
  ADD COLUMN "supplierAddressSnapshot" JSONB,
  ADD COLUMN "serviceChargeBpsSnapshot" INTEGER NOT NULL DEFAULT 0;

UPDATE "bills" AS b
SET "gstProfile" = t."gstProfile",
    "gstRateBpsSnapshot" = t."gstRateBps",
    "gstinSnapshot" = t."gstin",
    "supplierNameSnapshot" = t."name",
    "supplierAddressSnapshot" = o."address",
    "serviceChargeBpsSnapshot" = o."serviceChargeBps"
FROM "tenants" AS t, "outlets" AS o
WHERE b."tenantId" = t."id" AND b."outletId" = o."id";

ALTER TABLE "bills" ALTER COLUMN "supplierNameSnapshot" SET NOT NULL;
ALTER TABLE "bills" ALTER COLUMN "documentType" SET DEFAULT 'RECEIPT';
ALTER TABLE "bills" ALTER COLUMN "gstProfile" SET DEFAULT 'NOT_REGISTERED';
ALTER TABLE "bills" ALTER COLUMN "gstRateBpsSnapshot" SET DEFAULT 0;
ALTER TABLE "bills" ADD CONSTRAINT "bills_gstRateBpsSnapshot_check" CHECK ("gstRateBpsSnapshot" BETWEEN 0 AND 10000);

ALTER TABLE "outlets" DROP COLUMN "gstin";

-- Down migration (manual/reversible): add outlets.gstin; populate it from tenants.gstin;
-- restore menu_items.gstBps=500 where NULL and set its default/not-null constraints;
-- drop the bills tax/document/supplier/service-charge snapshot columns;
-- drop the tenant GST constraints/index/columns and remove both new enum types.
