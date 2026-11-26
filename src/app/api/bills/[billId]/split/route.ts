import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { allocatePaise } from "@/lib/billing";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

type BillForSplit = { totalPaise: bigint; order: { items: Array<{ id: string; quantity: number; unitPricePaise: bigint }> } };
type Allocation = { label: string; total: bigint; items: Array<{ orderItemId: string; quantity: number; amount: bigint }> };

function buildAllocations(bill: BillForSplit, body: Record<string, unknown>): Allocation[] {
  const allocations: Allocation[] = [];
  if (body.mode === "amount") {
    const amounts: number[] = Array.isArray(body.amounts) ? body.amounts as number[] : [];
    if (amounts.length < 2 || amounts.length > 12 || amounts.some((n) => !Number.isSafeInteger(n) || n < 0) || amounts.reduce((sum, amount) => sum + BigInt(amount), BigInt(0)) !== bill.totalPaise) {
      throw new RangeError("Enter 2–12 non-negative amounts in paise that add up exactly to the bill total.");
    }
    amounts.forEach((amount, index) => allocations.push({ label: `Split ${index + 1}`, total: BigInt(amount), items: [] }));
  } else if (body.mode === "items") {
    const groups: Array<{ label?: unknown; items?: Array<{ orderItemId?: unknown; quantity?: unknown }> }> = Array.isArray(body.splits) ? body.splits as typeof groups : [];
    if (groups.length < 2 || groups.length > 12) throw new RangeError("Item split needs 2–12 guests.");
    const itemById = new Map(bill.order.items.map((item) => [item.id, item]));
    const quantities = new Map<string, number>();
    const rawWeights: bigint[] = [];
    const normalized = groups.map((group, index) => {
      if (!Array.isArray(group.items) || !group.items.length) throw new RangeError("Each guest must receive at least one item");
      const items = group.items.map((line) => {
        const orderItemId = typeof line.orderItemId === "string" ? line.orderItemId : "";
        const quantity = Number(line.quantity);
        const item = itemById.get(orderItemId);
        if (!item || !Number.isInteger(quantity) || quantity < 1) throw new RangeError("Invalid order item or quantity in split");
        quantities.set(orderItemId, (quantities.get(orderItemId) ?? 0) + quantity);
        return { orderItemId, quantity, raw: item.unitPricePaise * BigInt(quantity) };
      });
      const raw = items.reduce((sum, item) => sum + item.raw, BigInt(0));
      rawWeights.push(raw);
      return { label: typeof group.label === "string" && group.label.trim() ? group.label.trim().slice(0, 50) : `Guest ${index + 1}`, items, raw };
    });
    for (const item of bill.order.items) if (quantities.get(item.id) !== item.quantity) throw new RangeError("Split quantities must account for every ordered item exactly once");
    const splitTotals = allocatePaise(bill.totalPaise, rawWeights);
    normalized.forEach((group, index) => {
      const lineAmounts = allocatePaise(splitTotals[index], group.items.map((item) => item.raw));
      allocations.push({ label: group.label, total: splitTotals[index], items: group.items.map((item, itemIndex) => ({ orderItemId: item.orderItemId, quantity: item.quantity, amount: lineAmounts[itemIndex] })) });
    });
  } else {
    throw new RangeError("Mode must be amount or items.");
  }
  return allocations;
}

async function POSTHandler(request: NextRequest, context: { params: Promise<{ billId: string }> }) {
  try {
    const { billId } = await context.params;
    const body = await readJsonObject(request);
    const mode = body.mode === "amount" || body.mode === "items" ? body.mode : null;
    if (!mode) return NextResponse.json({ error: "Mode must be amount or items." }, { status: 400 });
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "bills.split");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

    const result = await prisma.$transaction(async (tx) => {
      // Serialize split allocation on the bill row, then re-read state under the lock.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "bills" WHERE "id" = ${billId} AND "outletId" = ${outletId} AND "tenantId" = ${access.tenantId} FOR UPDATE`;
      if (!locked.length) return { kind: "missing" as const };
      const bill = await tx.bill.findFirst({ where: { id: billId, outletId, tenantId: access.tenantId }, include: { splits: true, order: { include: { items: true } } } });
      if (!bill) return { kind: "missing" as const };
      if (bill.splits.length) return { kind: "conflict" as const };
      const allocations = buildAllocations(bill, body);
      const splits = [];
      for (const allocation of allocations) {
        const split = await tx.billSplit.create({ data: { billId, label: allocation.label, totalPaise: allocation.total, items: { create: allocation.items.map((item) => ({ orderItemId: item.orderItemId, quantity: item.quantity, amountPaise: item.amount })) } } });
        splits.push(split);
      }
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "BILL_SPLIT", entityType: "Bill", entityId: billId, after: { mode, splits: splits.map((split) => ({ id: split.id, label: split.label, totalPaise: split.totalPaise.toString() })) } } });
      return { kind: "created" as const, splits };
    });

    if (result.kind === "missing") return NextResponse.json({ error: "Bill not found." }, { status: 404 });
    if (result.kind === "conflict") return NextResponse.json({ error: "This bill already has a split allocation." }, { status: 409 });
    return NextResponse.json({ splits: safeJson(result.splits) }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not split bill." }, { status: 500 });
  }
}

export const POST = withTenantScope(POSTHandler);
