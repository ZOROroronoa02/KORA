-- Reversal for 20261127100000_kds_phase2. KDS-only state and routing data is removed;
-- legacy KOT.status, KOTItem.status, order, and billing data remain intact.
ALTER TABLE "kot_mutations" DROP CONSTRAINT IF EXISTS "kot_mutations_ticketId_fkey";
ALTER TABLE "kot_mutations" DROP CONSTRAINT IF EXISTS "kot_mutations_outletId_fkey";
ALTER TABLE "kots" DROP CONSTRAINT IF EXISTS "kots_stationId_fkey";
ALTER TABLE "kots" DROP CONSTRAINT IF EXISTS "kots_outletId_fkey";
ALTER TABLE "outlet_menu_items" DROP CONSTRAINT IF EXISTS "outlet_menu_items_stationId_fkey";
ALTER TABLE "stations" DROP CONSTRAINT IF EXISTS "stations_outletId_fkey";

DROP INDEX IF EXISTS "kot_mutations_outletId_clientMutationId_key";
DROP INDEX IF EXISTS "kot_mutations_outletId_createdAt_idx";
DROP INDEX IF EXISTS "kots_outletId_kotNumber_key";
DROP INDEX IF EXISTS "kots_outletId_status_createdAt_idx";
DROP INDEX IF EXISTS "kots_outletId_stationId_status_createdAt_idx";
DROP INDEX IF EXISTS "stations_outletId_name_key";
DROP INDEX IF EXISTS "stations_outletId_active_sortOrder_idx";

ALTER TABLE "kot_items" DROP COLUMN "state", DROP COLUMN "updatedAt";
ALTER TABLE "kots" DROP COLUMN "createdAt", DROP COLUMN "heldAt", DROP COLUMN "holdDurationSeconds", DROP COLUMN "holdReason", DROP COLUMN "isRush", DROP COLUMN "kotNumber", DROP COLUMN "notes", DROP COLUMN "orderType", DROP COLUMN "outletId", DROP COLUMN "servedAt", DROP COLUMN "startedAt", DROP COLUMN "stationId", DROP COLUMN "tableLabel", DROP COLUMN "undoBumpUntil", DROP COLUMN "updatedAt", DROP COLUMN "waiterName";
ALTER TABLE "outlet_menu_items" DROP COLUMN "stationId";
ALTER TABLE "outlets" DROP COLUMN "kotNextNumber";
DROP TABLE "kot_mutations";
DROP TABLE "stations";
DROP TYPE "KOTItemState";
