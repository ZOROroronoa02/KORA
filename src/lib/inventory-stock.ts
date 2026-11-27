import { Prisma, StockMovementType } from "@prisma/client";
import { recipeDeductionsByOrderItem, type RecipeBOM, type SoldOrderItemLine } from "@/lib/domain/recipe-consumption";
import { stockShortagePolicyForOutlet } from "@/lib/domain/discount-approval";

const MAX_STOCK_QUANTITY = 9_223_372_036_854_775_807n;

type LockedMaterial = { id: string; name: string; quantityMilli: bigint };

export class InsufficientRecipeStockError extends Error {
  constructor(readonly shortages: Array<{ material: string; availableMilli: string; requiredMilli: string }>) {
    super(`Insufficient stock for ${shortages.map((entry) => entry.material).join(", ")}.`);
    this.name = "InsufficientRecipeStockError";
  }
}

/** Deducts outlet recipe stock and writes its movement ledger in the sale transaction. */
export async function consumeRecipeStock(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  outletId: string;
  orderId: string;
  orderNumber: number;
  lines: SoldOrderItemLine[];
}) {
  const menuItemIds = [...new Set(input.lines.map((line) => line.menuItemId))];
  if (menuItemIds.length === 0) return { shortages: [] };
  const [recipes, settingsRow] = await Promise.all([
    input.tx.recipe.findMany({
      where: { tenantId: input.tenantId, outletId: input.outletId, menuItemId: { in: menuItemIds } },
      select: { menuItemId: true, yieldQuantity: true, ingredients: { select: { rawMaterialId: true, quantityMilli: true } } },
    }),
    input.tx.outletSettings.findUnique({ where: { outletId: input.outletId }, select: { settings: true } }),
  ]);
  const deductions = recipeDeductionsByOrderItem(input.lines, recipes as RecipeBOM[]);
  if (deductions.length === 0) return { shortages: [] };

  const requiredByMaterial = new Map<string, bigint>();
  for (const deduction of deductions) {
    const next = (requiredByMaterial.get(deduction.rawMaterialId) ?? 0n) + deduction.quantityMilli;
    if (next > MAX_STOCK_QUANTITY) throw new RangeError("Recipe stock deduction exceeds the supported quantity range.");
    requiredByMaterial.set(deduction.rawMaterialId, next);
  }
  const materialIds = [...requiredByMaterial.keys()].sort((left, right) => left.localeCompare(right));
  const materials = await input.tx.$queryRaw<LockedMaterial[]>`
    SELECT "id", "name", "quantityMilli"
    FROM "raw_materials"
    WHERE "tenantId" = ${input.tenantId}
      AND "outletId" = ${input.outletId}
      AND "id" IN (${Prisma.join(materialIds)})
    ORDER BY "id"
    FOR UPDATE
  `;
  if (materials.length !== materialIds.length) throw new RangeError("A recipe ingredient is no longer available in this outlet.");

  const shortages: Array<{ material: string; availableMilli: string; requiredMilli: string }> = [];
  for (const material of materials) {
    const required = requiredByMaterial.get(material.id)!;
    const nextQuantity = material.quantityMilli - required;
    if (nextQuantity < -MAX_STOCK_QUANTITY) throw new RangeError("Recipe stock deduction exceeds the supported quantity range.");
    if (nextQuantity < 0n) shortages.push({ material: material.name, availableMilli: material.quantityMilli.toString(), requiredMilli: required.toString() });
  }
  const policy = stockShortagePolicyForOutlet(settingsRow?.settings);
  if (shortages.length && policy === "BLOCK") throw new InsufficientRecipeStockError(shortages);

  for (const material of materials) {
    const required = requiredByMaterial.get(material.id)!;
    const changed = await input.tx.rawMaterial.updateMany({
      where: { id: material.id, tenantId: input.tenantId, outletId: input.outletId, quantityMilli: material.quantityMilli },
      data: { quantityMilli: { decrement: required } },
    });
    if (changed.count !== 1) throw new RangeError("Stock changed while the order was being created. Refresh and retry.");
  }

  await input.tx.stockMovement.createMany({ data: deductions.map((deduction) => ({
    outletId: input.outletId,
    rawMaterialId: deduction.rawMaterialId,
    type: StockMovementType.SALE,
    quantityMilli: -deduction.quantityMilli,
    recipeYieldQuantity: deduction.recipeYieldQuantity,
    recipeIngredientQuantityMilli: deduction.recipeIngredientQuantityMilli,
    recipeQuantityBefore: deduction.recipeQuantityBefore,
    referenceId: deduction.orderItemId,
    reason: `Recipe consumption for order ${input.orderNumber}`,
  })) });

  if (shortages.length) {
    await input.tx.auditLog.create({ data: {
      tenantId: input.tenantId,
      outletId: input.outletId,
      action: "STOCK_SHORTAGE_ALLOWED",
      entityType: "Order",
      entityId: input.orderId,
      reason: "Outlet policy allows a recipe-linked sale to take stock below zero.",
      after: { orderNumber: input.orderNumber, shortages },
    } });
  }
  return { shortages };
}

/** Restores only recipe quantities explicitly confirmed as unstarted by the KOT ledger. */
export async function restoreUnstartedRecipeStock(input: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  outletId: string;
  orderId: string;
  orderItems: Array<{ id: string; quantity: number }>;
  kotItems: Array<{ orderItemId: string; quantity: number; state: string }>;
}) {
  const orderItemIds = input.orderItems.map((item) => item.id);
  if (orderItemIds.length === 0) return { restored: [], missingSnapshotCount: 0, untrackedOrderItemCount: 0 };
  const sales = await input.tx.stockMovement.findMany({
    where: { outletId: input.outletId, referenceId: { in: orderItemIds }, type: StockMovementType.SALE, rawMaterial: { tenantId: input.tenantId, outletId: input.outletId } },
    select: { rawMaterialId: true, referenceId: true, quantityMilli: true, recipeYieldQuantity: true, recipeIngredientQuantityMilli: true, recipeQuantityBefore: true },
  });
  if (sales.length === 0) return { restored: [], missingSnapshotCount: 0, untrackedOrderItemCount: 0 };

  const unstartedByOrderItem = new Map<string, number>();
  const trackedByOrderItem = new Map<string, number>();
  for (const item of input.kotItems) {
    trackedByOrderItem.set(item.orderItemId, (trackedByOrderItem.get(item.orderItemId) ?? 0) + item.quantity);
    if (item.state === "QUEUED" || item.state === "OUT_OF_STOCK") {
      unstartedByOrderItem.set(item.orderItemId, (unstartedByOrderItem.get(item.orderItemId) ?? 0) + item.quantity);
    }
  }
  const saleByOrderItem = new Map<string, typeof sales>();
  for (const movement of sales) {
    if (!movement.referenceId || movement.quantityMilli >= 0n) continue;
    const movements = saleByOrderItem.get(movement.referenceId) ?? [];
    movements.push(movement);
    saleByOrderItem.set(movement.referenceId, movements);
  }

  const restoreByMaterial = new Map<string, bigint>();
  let missingSnapshotCount = 0;
  let untrackedOrderItemCount = 0;
  for (const orderItem of input.orderItems) {
    const saleMovements = saleByOrderItem.get(orderItem.id);
    if (!saleMovements) continue;
    const unstartedQuantity = Math.min(orderItem.quantity, unstartedByOrderItem.get(orderItem.id) ?? 0);
    if ((trackedByOrderItem.get(orderItem.id) ?? 0) < orderItem.quantity) untrackedOrderItemCount++;
    for (const movement of saleMovements) {
      const soldQuantity = -movement.quantityMilli;
      if (movement.recipeYieldQuantity === null || movement.recipeIngredientQuantityMilli === null || movement.recipeQuantityBefore === null) {
        // Never guess from a mutable recipe when the original sale ledger lacks a BOM snapshot.
        missingSnapshotCount++;
        continue;
      }
      const yieldQuantity = BigInt(movement.recipeYieldQuantity);
      const ingredientQuantity = movement.recipeIngredientQuantityMilli;
      const quantityBefore = movement.recipeQuantityBefore;
      const roundUp = (quantity: bigint) => (ingredientQuantity * quantity + yieldQuantity - 1n) / yieldQuantity;
      const fullSaleUsage = roundUp(quantityBefore + BigInt(orderItem.quantity)) - roundUp(quantityBefore);
      if (fullSaleUsage !== soldQuantity) throw new RangeError("Recipe sale snapshot does not match the sold order quantity.");
      // Treat unstarted units as the last portion of a line. Any untracked quantity
      // stays consumed, so missing KOT rows can never create phantom stock.
      const consumedQuantity = BigInt(orderItem.quantity - unstartedQuantity);
      const restore = roundUp(quantityBefore + BigInt(orderItem.quantity)) - roundUp(quantityBefore + consumedQuantity);
      if (restore > 0n) {
        const next = (restoreByMaterial.get(movement.rawMaterialId) ?? 0n) + restore;
        if (next > MAX_STOCK_QUANTITY) throw new RangeError("Recipe stock restoration exceeds the supported quantity range.");
        restoreByMaterial.set(movement.rawMaterialId, next);
      }
    }
  }
  if (restoreByMaterial.size === 0) return { restored: [], missingSnapshotCount, untrackedOrderItemCount };

  const materialIds = [...restoreByMaterial.keys()].sort((left, right) => left.localeCompare(right));
  const materials = await input.tx.$queryRaw<LockedMaterial[]>`
    SELECT "id", "name", "quantityMilli"
    FROM "raw_materials"
    WHERE "tenantId" = ${input.tenantId}
      AND "outletId" = ${input.outletId}
      AND "id" IN (${Prisma.join(materialIds)})
    ORDER BY "id"
    FOR UPDATE
  `;
  if (materials.length !== materialIds.length) throw new RangeError("A consumed recipe ingredient is no longer available in this outlet.");
  const changedStock = [] as Array<{ id: string; name: string; beforeMilli: string; afterMilli: string; restoredMilli: string }>;
  for (const material of materials) {
    const restored = restoreByMaterial.get(material.id)!;
    const next = material.quantityMilli + restored;
    if (next > MAX_STOCK_QUANTITY) throw new RangeError("Recipe stock restoration exceeds the supported quantity range.");
    const changed = await input.tx.rawMaterial.updateMany({
      where: { id: material.id, tenantId: input.tenantId, outletId: input.outletId, quantityMilli: material.quantityMilli },
      data: { quantityMilli: { increment: restored } },
    });
    if (changed.count !== 1) throw new RangeError("Stock changed while the order was being voided. Retry the void.");
    changedStock.push({ id: material.id, name: material.name, beforeMilli: material.quantityMilli.toString(), afterMilli: next.toString(), restoredMilli: restored.toString() });
  }
  await input.tx.stockMovement.createMany({ data: materials.map((material) => ({
    outletId: input.outletId,
    rawMaterialId: material.id,
    type: StockMovementType.SALE_REVERSAL,
    quantityMilli: restoreByMaterial.get(material.id)!,
    referenceId: input.orderId,
    reason: "Restore recipe stock for KOT items that had not started when the order was voided.",
  })) });
  return { restored: changedStock, missingSnapshotCount, untrackedOrderItemCount };
}
