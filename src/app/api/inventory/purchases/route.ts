import { createHash } from "node:crypto";
import { Prisma, StockMovementType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { purchaseLineTotalPaise, purchaseTotalPaise, movingWeightedAverageUnitCostPaise, nextStockQuantity } from "@/lib/domain/inventory-costing";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { isTransactionConflict } from "@/lib/db-conflicts";
import { prisma } from "@/lib/prisma";
import { requirePermission, withTenantScope } from "@/lib/server-auth";

export const runtime = "nodejs";

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_DATABASE_INTEGER = 9_223_372_036_854_775_807n;
const purchaseInclude = {
  vendor: { select: { id: true, name: true } },
  lines: {
    orderBy: { rawMaterialId: "asc" },
    include: { rawMaterial: { select: { id: true, name: true, unit: true } } },
  },
} satisfies Prisma.PurchaseInclude;

type PurchaseView = Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>;
type ReceiptLine = { rawMaterialId: string; quantityMilli: bigint; unitCostPaise: bigint };
type LockedMaterial = { id: string; name: string; unit: string; quantityMilli: bigint; costPerUnitPaise: bigint };

class PurchaseMaterialNotFoundError extends Error {}
class PurchaseVendorNotFoundError extends Error {}
class PurchaseIdempotencyConflictError extends Error {}
class PurchaseStockConflictError extends Error {}

function safeJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
}

function publicPurchase(purchase: PurchaseView) {
  const { idempotencyKey: _idempotencyKey, idempotencyPayloadHash: _idempotencyPayloadHash, ...visible } = purchase;
  return safeJson(visible);
}

function integerInput(value: unknown, allowZero: boolean): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1)) return BigInt(value);
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed > MAX_DATABASE_INTEGER || (!allowZero && parsed === 0n)) return null;
  return parsed;
}

function authError(error: "Unauthenticated" | "Forbidden") {
  return NextResponse.json({ error }, { status: error === "Unauthenticated" ? 401 : 403 });
}

function createReceiptHash(input: { outletId: string; vendorId: string | null; reference: string | null; lines: ReceiptLine[] }) {
  const canonical = {
    outletId: input.outletId,
    vendorId: input.vendorId,
    reference: input.reference,
    lines: input.lines.map((line) => ({ rawMaterialId: line.rawMaterialId, quantityMilli: line.quantityMilli.toString(), unitCostPaise: line.unitCostPaise.toString() })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function receiptResponse(purchase: PurchaseView, replayed: boolean) {
  return NextResponse.json({ purchase: publicPurchase(purchase), replayed }, { status: replayed ? 200 : 201 });
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  const access = await requirePermission(request, outletId, "inventory.view");
  if ("error" in access) return authError(access.error);

  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? PAGE_SIZE);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return NextResponse.json({ error: "Purchase page size must be a positive integer." }, { status: 400 });
  const limit = Math.min(requestedLimit, MAX_PAGE_SIZE);
  const cursor = request.nextUrl.searchParams.get("cursor")?.trim() ?? "";
  if (cursor.length > 100) return NextResponse.json({ error: "Invalid purchase cursor." }, { status: 400 });
  if (cursor && !(await prisma.purchase.findFirst({ where: { id: cursor, tenantId: access.tenantId, outletId }, select: { id: true } }))) {
    return NextResponse.json({ error: "Invalid purchase cursor." }, { status: 400 });
  }

  const rows = await prisma.purchase.findMany({
    where: { tenantId: access.tenantId, outletId },
    orderBy: [{ purchasedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: purchaseInclude,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return NextResponse.json({ items: page.map(publicPurchase), nextCursor: hasMore ? page.at(-1)?.id ?? null : null }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function POSTHandler(request: NextRequest) {
  let outletId = "";
  let idempotencyKey = "";
  let requestHash = "";
  try {
    const body = await readJsonObject(request, 32 * 1024);
    outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const access = await requirePermission(request, outletId, "inventory.adjust");
    if ("error" in access) return authError(access.error);

    idempotencyKey = typeof body.clientMutationId === "string" ? body.clientMutationId.trim().toLowerCase() : "";
    const vendorId = body.vendorId === null || body.vendorId === undefined || body.vendorId === "" ? null : typeof body.vendorId === "string" ? body.vendorId.trim() : "invalid";
    const reference = typeof body.reference === "string" ? body.reference.trim() || null : body.reference === null || body.reference === undefined ? null : "invalid";
    const inputLines: Array<{ rawMaterialId?: unknown; quantityMilli?: unknown; unitCostPaise?: unknown }> = Array.isArray(body.lines) ? body.lines : [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)
      || (vendorId !== null && (vendorId === "invalid" || vendorId.length > 100))
      || (reference !== null && (reference === "invalid" || reference.length > 100 || /[\u0000-\u001f\u007f]/.test(reference)))
      || inputLines.length < 1 || inputLines.length > 100) {
      return NextResponse.json({ error: "Provide a valid receipt request ID, optional vendor/reference, and 1–100 lines." }, { status: 400 });
    }

    const lines: ReceiptLine[] = inputLines.map((line) => ({
      rawMaterialId: typeof line.rawMaterialId === "string" ? line.rawMaterialId.trim() : "",
      quantityMilli: integerInput(line.quantityMilli, false) ?? -1n,
      unitCostPaise: integerInput(line.unitCostPaise, true) ?? -1n,
    }));
    if (lines.some((line) => !line.rawMaterialId || line.rawMaterialId.length > 100 || line.quantityMilli < 1n || line.unitCostPaise < 0n)
      || new Set(lines.map((line) => line.rawMaterialId)).size !== lines.length) {
      return NextResponse.json({ error: "Each line needs a unique outlet ingredient, positive milli-unit quantity, and non-negative landed unit cost in paise." }, { status: 400 });
    }
    lines.sort((left, right) => left.rawMaterialId.localeCompare(right.rawMaterialId));
    const totalPaise = purchaseTotalPaise(lines);
    requestHash = createReceiptHash({ outletId, vendorId, reference, lines });

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.purchase.findUnique({ where: { outletId_idempotencyKey: { outletId, idempotencyKey } }, include: purchaseInclude });
      if (existing) {
        if (existing.idempotencyPayloadHash !== requestHash) throw new PurchaseIdempotencyConflictError();
        return { purchase: existing, replayed: true };
      }

      let vendorName: string | null = null;
      if (vendorId) {
        const vendor = await tx.vendor.findFirst({ where: { id: vendorId, tenantId: access.tenantId, active: true }, select: { id: true, name: true } });
        if (!vendor) throw new PurchaseVendorNotFoundError();
        vendorName = vendor.name;
      }

      const materialIds = lines.map((line) => line.rawMaterialId);
      const materials = await tx.$queryRaw<LockedMaterial[]>`
        SELECT "id", "name", "unit", "quantityMilli", "costPerUnitPaise"
        FROM "raw_materials"
        WHERE "tenantId" = ${access.tenantId}
          AND "outletId" = ${outletId}
          AND "id" IN (${Prisma.join(materialIds)})
        ORDER BY "id"
        FOR UPDATE
      `;
      if (materials.length !== lines.length) throw new PurchaseMaterialNotFoundError();

      const materialsById = new Map(materials.map((material) => [material.id, material]));
      const nextMaterials = lines.map((line) => {
        const material = materialsById.get(line.rawMaterialId);
        if (!material) throw new PurchaseMaterialNotFoundError();
        return {
          line,
          material,
          nextQuantityMilli: nextStockQuantity(material.quantityMilli, line.quantityMilli),
          nextCostPerUnitPaise: movingWeightedAverageUnitCostPaise({
            quantityBeforeMilli: material.quantityMilli,
            unitCostBeforePaise: material.costPerUnitPaise,
            quantityReceivedMilli: line.quantityMilli,
            landedUnitCostPaise: line.unitCostPaise,
          }),
        };
      });

      const purchase = await tx.purchase.create({
        data: {
          tenantId: access.tenantId,
          outletId,
          vendorId,
          reference,
          totalPaise,
          status: "RECEIVED",
          idempotencyKey,
          idempotencyPayloadHash: requestHash,
          lines: { create: lines.map((line) => ({ rawMaterialId: line.rawMaterialId, quantityMilli: line.quantityMilli, unitCostPaise: line.unitCostPaise })) },
        },
        include: purchaseInclude,
      });

      for (const { line, material, nextQuantityMilli, nextCostPerUnitPaise } of nextMaterials) {
        const updated = await tx.rawMaterial.updateMany({
          where: {
            id: material.id,
            tenantId: access.tenantId,
            outletId,
            quantityMilli: material.quantityMilli,
            costPerUnitPaise: material.costPerUnitPaise,
          },
          data: { quantityMilli: nextQuantityMilli, costPerUnitPaise: nextCostPerUnitPaise },
        });
        if (updated.count !== 1) throw new PurchaseStockConflictError();
      }

      await tx.stockMovement.createMany({
        data: lines.map((line) => ({
          outletId,
          rawMaterialId: line.rawMaterialId,
          type: StockMovementType.PURCHASE,
          quantityMilli: line.quantityMilli,
          unitCostPaise: line.unitCostPaise,
          referenceId: purchase.id,
          reason: `Received vendor purchase${reference ? ` ${reference}` : ""}`,
        })),
      });
      await tx.auditLog.create({
        data: {
          tenantId: access.tenantId,
          outletId,
          userId: access.user.id,
          action: "INVENTORY_PURCHASE_RECEIVED",
          entityType: "Purchase",
          entityId: purchase.id,
          before: { materials: nextMaterials.map(({ material }) => ({ rawMaterialId: material.id, quantityMilli: material.quantityMilli.toString(), costPerUnitPaise: material.costPerUnitPaise.toString() })) },
          after: {
            vendorId,
            vendorName,
            reference,
            totalPaise: totalPaise.toString(),
            lines: nextMaterials.map(({ line, material, nextQuantityMilli, nextCostPerUnitPaise }) => ({
              rawMaterialId: material.id,
              name: material.name,
              quantityMilli: line.quantityMilli.toString(),
              landedUnitCostPaise: line.unitCostPaise.toString(),
              lineTotalPaise: purchaseLineTotalPaise(line.quantityMilli, line.unitCostPaise).toString(),
              quantityAfterMilli: nextQuantityMilli.toString(),
              costPerUnitAfterPaise: nextCostPerUnitPaise.toString(),
            })),
          },
        },
      });
      return { purchase, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return receiptResponse(result.purchase, result.replayed);
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof PurchaseIdempotencyConflictError) return NextResponse.json({ error: "This receipt request ID was already used for a different payload." }, { status: 409 });
    if (error instanceof PurchaseMaterialNotFoundError || error instanceof PurchaseVendorNotFoundError) return NextResponse.json({ error: "Vendor or ingredient was not found for this outlet." }, { status: 404 });
    if (error instanceof PurchaseStockConflictError) return NextResponse.json({ error: "Stock changed concurrently. Retry this receipt request." }, { status: 409 });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    const uniqueConflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
    if ((uniqueConflict || isTransactionConflict(error)) && outletId && idempotencyKey && requestHash) {
      const existing = await prisma.purchase.findUnique({ where: { outletId_idempotencyKey: { outletId, idempotencyKey } }, include: purchaseInclude }).catch(() => null);
      if (existing) {
        if (existing.idempotencyPayloadHash !== requestHash) return NextResponse.json({ error: "This receipt request ID was already used for a different payload." }, { status: 409 });
        return receiptResponse(existing, true);
      }
      if (isTransactionConflict(error)) return NextResponse.json({ error: "Inventory changed concurrently. Retry this receipt request." }, { status: 409 });
    }
    if (isTransactionConflict(error)) return NextResponse.json({ error: "Inventory changed concurrently. Retry this receipt request." }, { status: 409 });
    console.error("KORA purchase receipt failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not receive this purchase." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
