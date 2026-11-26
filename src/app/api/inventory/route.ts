import { NextRequest, NextResponse } from "next/server";
import { StockMovementType } from "@prisma/client";
import { requirePermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

export async function GET(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "inventory.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const materials = await prisma.rawMaterial.findMany({ where: { tenantId: access.tenantId, outletId }, orderBy: { name: "asc" } });
  return NextResponse.json(safeJson(materials));
}

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "inventory.adjust");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const operation = typeof body.operation === "string" ? body.operation : "";
    const rawMaterialId = typeof body.rawMaterialId === "string" ? body.rawMaterialId : "";
    const quantityMilli = Number(body.quantityMilli);
    const unitCostPaise = body.unitCostPaise === undefined ? undefined : Number(body.unitCostPaise);
    if (!["adjust", "purchase", "wastage"].includes(operation) || !rawMaterialId || !Number.isSafeInteger(quantityMilli) || quantityMilli === 0 || (unitCostPaise !== undefined && (!Number.isSafeInteger(unitCostPaise) || unitCostPaise < 0))) return NextResponse.json({ error: "Provide a valid stock operation, ingredient, quantity in milli-units, and optional unit cost in paise." }, { status: 400 });
    if (operation === "purchase" && quantityMilli < 0) return NextResponse.json({ error: "Purchase quantity must be positive." }, { status: 400 });
    if (operation === "wastage" && quantityMilli < 0) return NextResponse.json({ error: "Wastage quantity must be positive." }, { status: 400 });
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    if (operation === "wastage" && reason.length < 3) return NextResponse.json({ error: "A reason is required for wastage." }, { status: 400 });
    const material = await prisma.rawMaterial.findFirst({ where: { id: rawMaterialId, tenantId: access.tenantId, outletId } });
    if (!material) return NextResponse.json({ error: "Ingredient not found in this outlet." }, { status: 404 });
    const signedQuantity = operation === "wastage" ? -quantityMilli : quantityMilli;
    const type = operation === "purchase" ? StockMovementType.PURCHASE : operation === "wastage" ? StockMovementType.WASTAGE : StockMovementType.ADJUSTMENT;
    const result = await prisma.$transaction(async (tx) => {
      const saved = await tx.rawMaterial.updateMany({ where: { id: rawMaterialId, outletId, tenantId: access.tenantId, ...(signedQuantity < 0 ? { quantityMilli: { gte: BigInt(-signedQuantity) } } : {}) }, data: { quantityMilli: { increment: BigInt(signedQuantity) }, ...(unitCostPaise !== undefined && operation === "purchase" ? { costPerUnitPaise: BigInt(unitCostPaise) } : {}) } });
      if (saved.count !== 1) throw new RangeError("Insufficient stock for this adjustment.");
      const movement = await tx.stockMovement.create({ data: { outletId, rawMaterialId, type, quantityMilli: BigInt(signedQuantity), unitCostPaise: unitCostPaise === undefined ? undefined : BigInt(unitCostPaise), reason: reason || undefined } });
      if (operation === "wastage") await tx.wastage.create({ data: { outletId, rawMaterialId, quantityMilli: BigInt(quantityMilli), reason } });
      const updated = await tx.rawMaterial.findUniqueOrThrow({ where: { id: rawMaterialId } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: `STOCK_${operation.toUpperCase()}`, entityType: "RawMaterial", entityId: rawMaterialId, before: { quantityMilli: material.quantityMilli.toString() }, after: { quantityMilli: updated.quantityMilli.toString() }, reason: reason || undefined } });
      return { material: updated, movement };
    });
    return NextResponse.json(safeJson(result), { status: 201 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "Could not update ingredient stock." }, { status: 500 });
  }
}
