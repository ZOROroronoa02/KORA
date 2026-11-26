-- CreateEnum
CREATE TYPE "KOTItemState" AS ENUM ('QUEUED', 'COOKING', 'READY', 'BUMPED', 'OUT_OF_STOCK');

-- AlterTable
ALTER TABLE "kot_items" ADD COLUMN     "state" "KOTItemState" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "kots" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "holdDurationSeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "isRush" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kotNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "orderType" "OrderType" NOT NULL DEFAULT 'DINE_IN',
ADD COLUMN     "outletId" TEXT,
ADD COLUMN     "servedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "stationId" TEXT,
ADD COLUMN     "tableLabel" TEXT,
ADD COLUMN     "undoBumpUntil" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "waiterName" TEXT;

-- AlterTable
ALTER TABLE "outlet_menu_items" ADD COLUMN     "stationId" TEXT;

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN     "kotNextNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "stations" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kot_mutations" (
    "id" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "ticketId" TEXT,
    "userId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kot_mutations_pkey" PRIMARY KEY ("id")
);

-- Backfill existing KOTs before adding required outlet-scoped fields and indexes.
INSERT INTO "stations" ("id", "outletId", "name", "active", "sortOrder")
SELECT 'kds-general-' || o."id", o."id", 'General', true, 0
FROM "outlets" o
WHERE NOT EXISTS (SELECT 1 FROM "stations" s WHERE s."outletId" = o."id" AND s."name" = 'General');

UPDATE "kots" k
SET "outletId" = o."outletId",
    "stationId" = s."id",
    "orderType" = o."type",
    "tableLabel" = rt."label",
    "waiterName" = u."name",
    "createdAt" = k."sentAt",
    "startedAt" = CASE WHEN k."status" IN ('PREPARING', 'READY', 'SERVED') THEN k."sentAt" ELSE NULL END,
    "readyAt" = CASE WHEN k."status" IN ('READY', 'SERVED') THEN COALESCE(k."readyAt", k."sentAt") ELSE k."readyAt" END,
    "servedAt" = CASE WHEN k."status" = 'SERVED' THEN k."sentAt" ELSE NULL END
FROM "orders" o
LEFT JOIN "restaurant_tables" rt ON rt."id" = o."tableId"
LEFT JOIN "users" u ON u."id" = o."createdById"
JOIN "stations" s ON s."outletId" = o."outletId" AND s."name" = 'General'
WHERE k."orderId" = o."id";

WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "outletId" ORDER BY "sentAt", "id")::INTEGER AS "number"
  FROM "kots"
)
UPDATE "kots" k SET "kotNumber" = numbered."number"
FROM numbered WHERE numbered."id" = k."id";

UPDATE "outlets" o SET "kotNextNumber" = COALESCE((SELECT MAX(k."kotNumber") + 1 FROM "kots" k WHERE k."outletId" = o."id"), 1);
UPDATE "outlet_menu_items" omi SET "stationId" = s."id"
FROM "stations" s WHERE s."outletId" = omi."outletId" AND s."name" = 'General';
UPDATE "kot_items" ki SET
  "state" = CASE ki."status"
    WHEN 'QUEUED' THEN 'QUEUED'::"KOTItemState"
    WHEN 'PREPARING' THEN 'COOKING'::"KOTItemState"
    WHEN 'READY' THEN 'READY'::"KOTItemState"
    WHEN 'SERVED' THEN 'BUMPED'::"KOTItemState"
    ELSE 'OUT_OF_STOCK'::"KOTItemState"
  END,
  "updatedAt" = k."sentAt"
FROM "kots" k WHERE k."id" = ki."kotId";

ALTER TABLE "kots" ALTER COLUMN "outletId" SET NOT NULL;
ALTER TABLE "kots" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "kot_items" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "stations_outletId_active_sortOrder_idx" ON "stations"("outletId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "stations_outletId_name_key" ON "stations"("outletId", "name");

-- CreateIndex
CREATE INDEX "kot_mutations_outletId_createdAt_idx" ON "kot_mutations"("outletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kot_mutations_outletId_clientMutationId_key" ON "kot_mutations"("outletId", "clientMutationId");

-- CreateIndex
CREATE INDEX "kots_outletId_status_createdAt_idx" ON "kots"("outletId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "kots_outletId_stationId_status_createdAt_idx" ON "kots"("outletId", "stationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "kots_outletId_kotNumber_key" ON "kots"("outletId", "kotNumber");

-- AddForeignKey
ALTER TABLE "outlet_menu_items" ADD CONSTRAINT "outlet_menu_items_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kots" ADD CONSTRAINT "kots_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kots" ADD CONSTRAINT "kots_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kot_mutations" ADD CONSTRAINT "kot_mutations_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kot_mutations" ADD CONSTRAINT "kot_mutations_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "kots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

