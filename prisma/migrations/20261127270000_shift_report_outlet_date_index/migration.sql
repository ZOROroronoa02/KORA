-- Add the covering scope/order index used by bounded shift report pagination.
CREATE INDEX "shifts_tenantId_outletId_openedAt_id_idx"
ON "shifts" ("tenantId", "outletId", "openedAt", "id");

-- Down migration: DROP INDEX "shifts_tenantId_outletId_openedAt_id_idx";
