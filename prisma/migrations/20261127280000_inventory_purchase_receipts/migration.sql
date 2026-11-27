ALTER TABLE "purchases"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyPayloadHash" TEXT;

CREATE UNIQUE INDEX "purchases_outletId_idempotencyKey_key"
  ON "purchases"("outletId", "idempotencyKey");

CREATE INDEX "purchases_tenantId_outletId_purchasedAt_id_idx"
  ON "purchases"("tenantId", "outletId", "purchasedAt", "id");

-- Down migration: DROP INDEX "purchases_tenantId_outletId_purchasedAt_id_idx";
-- DROP INDEX "purchases_outletId_idempotencyKey_key";
-- ALTER TABLE "purchases" DROP COLUMN "idempotencyPayloadHash", DROP COLUMN "idempotencyKey";
