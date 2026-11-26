import { NextRequest, NextResponse } from "next/server";
import { Prisma, StockMovementType } from "@prisma/client";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
const MAX_STOCK_QUANTITY = 9_223_372_036_854_775_807n;

class InventoryRecordNotFoundError extends Error {}

function integerInput(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value) && value.length <= 19) return value;
  return null;
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "inventory.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const materials = await prisma.rawMaterial.findMany({ where: { tenantId: access.tenantId, outletId }, orderBy: { name: "asc" } });
  return NextResponse.json(safeJson(materials));
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "inventory.adjust");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const operation = typeof body.operation === "string" ? body.operation : "";
    if (operation === "create") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const unit = typeof body.unit === "string" ? body.unit.trim() : "";
      const reorderInput = integerInput(body.reorderMilli);
      const costInput = integerInput(body.costPerUnitPaise ?? "0");
      if (!name || name.length > 100 || !unit || unit.length > 16 || reorderInput === null || costInput === null) return NextResponse.json({ error: "Provide an ingredient name, unit, non-negative reorder quantity in milli-units, and unit cost in paise." }, { status: 400 });
      const reorderMilli = BigInt(reorderInput);
      const costPerUnitPaise = BigInt(costInput);
      if (reorderMilli > MAX_STOCK_QUANTITY || costPerUnitPaise > MAX_STOCK_QUANTITY) return NextResponse.json({ error: "Reorder quantity and unit cost must be within the supported range." }, { status: 400 });
      const material = await prisma.$transaction(async (tx) => {
        const created = await tx.rawMaterial.create({ data: { tenantId: access.tenantId, outletId, name, unit, reorderMilli, costPerUnitPaise } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "STOCK_MATERIAL_CREATED", entityType: "RawMaterial", entityId: created.id, after: { name, unit, quantityMilli: "0", reorderMilli: reorderMilli.toString(), costPerUnitPaise: costPerUnitPaise.toString() } } });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return NextResponse.json({ material: safeJson(material) }, { status: 201 });
    }
    const rawMaterialId = typeof body.rawMaterialId === "string" ? body.rawMaterialId : "";
    const rawQuantity = typeof body.quantityMilli === "number" && Number.isSafeInteger(body.quantityMilli)
      ? String(body.quantityMilli)
      : typeof body.quantityMilli === "string" ? body.quantityMilli : "";
    if (!["adjust", "wastage"].includes(operation) || !rawMaterialId || rawQuantity.length > 20 || !/^-?\d+$/.test(rawQuantity)) return NextResponse.json({ error: "Provide a valid stock correction or wastage, ingredient, and integer quantity in milli-units." }, { status: 400 });
    const quantityMilli = BigInt(rawQuantity);
    if (quantityMilli === 0n || quantityMilli > MAX_STOCK_QUANTITY || quantityMilli < -MAX_STOCK_QUANTITY) return NextResponse.json({ error: "Quantity must be non-zero and within the supported stock range." }, { status: 400 });
    if (operation === "wastage" && quantityMilli < 0n) return NextResponse.json({ error: "Wastage quantity must be positive." }, { status: 400 });
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 300) return NextResponse.json({ error: "A reason between 3 and 300 characters is required." }, { status: 400 });
    const signedQuantity = operation === "wastage" ? -quantityMilli : quantityMilli;
    const type = operation === "wastage" ? StockMovementType.WASTAGE : StockMovementType.ADJUSTMENT;
    const result = await prisma.$transaction(async (tx) => {
      const material = await tx.rawMaterial.findFirst({ where: { id: rawMaterialId, tenantId: access.tenantId, outletId } });
      if (!material) throw new InventoryRecordNotFoundError();
      const nextQuantity = material.quantityMilli + signedQuantity;
      if (nextQuantity < 0n) throw new RangeError("Insufficient stock for this adjustment.");
      if (nextQuantity > MAX_STOCK_QUANTITY) throw new RangeError("The resulting stock exceeds the supported quantity range.");
      const saved = await tx.rawMaterial.updateMany({ where: { id: rawMaterialId, outletId, tenantId: access.tenantId, ...(signedQuantity < 0n ? { quantityMilli: { gte: -signedQuantity } } : {}) }, data: { quantityMilli: { increment: signedQuantity } } });
      if (saved.count !== 1) throw new RangeError("Stock changed concurrently. Refresh and try again.");
      const movement = await tx.stockMovement.create({ data: { outletId, rawMaterialId, type, quantityMilli: signedQuantity, reason } });
      if (operation === "wastage") await tx.wastage.create({ data: { outletId, rawMaterialId, quantityMilli, reason } });
      const updated = await tx.rawMaterial.findFirstOrThrow({ where: { id: rawMaterialId, tenantId: access.tenantId, outletId } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: `STOCK_${operation.toUpperCase()}`, entityType: "RawMaterial", entityId: rawMaterialId, before: { quantityMilli: material.quantityMilli.toString() }, after: { quantityMilli: updated.quantityMilli.toString() }, reason } });
      return { material: updated, movement };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return NextResponse.json(safeJson(result), { status: 201 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof InventoryRecordNotFoundError) return NextResponse.json({ error: "Ingredient not found in this outlet." }, { status: 404 });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return NextResponse.json({ error: "Stock changed concurrently. Refresh and try again." }, { status: 409 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ error: "An ingredient with this name already exists in the outlet." }, { status: 409 });
    return NextResponse.json({ error: "Could not update ingredient stock." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
