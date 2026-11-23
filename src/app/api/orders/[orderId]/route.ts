import { NextRequest, NextResponse } from "next/server";
import { KOTStatus, OrderStatus } from "@prisma/client";
import { authorizeOutlet } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { publishOutletEvent } from "@/lib/realtime";
import { transitionOrder } from "@/lib/billing";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

export async function PATCH(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await context.params;
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const action = typeof body.action === "string" ? body.action : "";
    const permission = action === "kot-ready" || action === "kot-served" ? "kot.update" : action === "void" ? "order.void" : "order.create";
    const access = await authorizeOutlet(request, outletId, permission);
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const order = await prisma.order.findFirst({ where: { id: orderId, outletId, tenantId: access.tenantId }, include: { items: true, kots: { include: { items: true } }, bill: { include: { payments: true } } } });
    if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

    if (action === "kot-ready" || action === "kot-served") {
      let transition;
      try { transition = transitionOrder(order.status as Parameters<typeof transitionOrder>[0], action); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid order transition." }, { status: 409 }); }
      const status = transition.kotStatus as KOTStatus;
      const orderStatus = transition.orderStatus as OrderStatus;
      await prisma.$transaction(async (tx) => {
        const changed = await tx.order.updateMany({ where: { id: orderId, tenantId: access.tenantId, outletId, status: order.status }, data: { status: orderStatus } });
        if (changed.count !== 1) throw new RangeError("Order changed concurrently; reload before retrying.");
        const activeKotStates = status === KOTStatus.READY ? [KOTStatus.QUEUED, KOTStatus.PREPARING] : [KOTStatus.READY];
        const kots = await tx.kOT.updateMany({ where: { orderId, status: { in: activeKotStates } }, data: { status, ...(status === KOTStatus.READY ? { readyAt: new Date() } : {}) } });
        if (kots.count === 0) throw new RangeError("No active kitchen ticket can make this transition.");
        await tx.kOTItem.updateMany({ where: { kot: { orderId, status } }, data: { status } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: status === KOTStatus.READY ? "KOT_READY" : "ORDER_SERVED", entityType: "Order", entityId: orderId, before: { status: order.status }, after: { status: orderStatus } } });
      });
    } else if (action === "transfer-table") {
      if (order.type !== "DINE_IN") return NextResponse.json({ error: "Only dine-in orders can be transferred between tables." }, { status: 409 });
      const tableId = typeof body.tableId === "string" ? body.tableId : "";
      const table = await prisma.restaurantTable.findFirst({ where: { id: tableId, outletId, active: true } });
      if (!table) return NextResponse.json({ error: "Target table not found." }, { status: 404 });
      if (order.tableId === table.id) return NextResponse.json({ order: safeJson(order), unchanged: true });
      await prisma.$transaction(async (tx) => {
        const lockedTable = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "restaurant_tables" WHERE "id" = ${tableId} AND "outletId" = ${outletId} AND "active" = true FOR UPDATE`;
        if (!lockedTable.length) throw new RangeError("Target table is no longer active.");
        const occupied = await tx.order.findFirst({ where: { outletId, tableId, id: { not: orderId }, status: { in: [OrderStatus.OPEN, OrderStatus.SENT, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.SERVED] } }, select: { id: true } });
        if (occupied) throw new RangeError("Target table already has an active order.");
        const changed = await tx.order.updateMany({ where: { id: orderId, tenantId: access.tenantId, outletId, tableId: order.tableId, status: order.status }, data: { tableId } });
        if (changed.count !== 1) throw new RangeError("Order changed concurrently; reload before retrying.");
        await tx.tableEvent.create({ data: { orderId, kind: "TRANSFER", fromTable: order.tableId, toTable: table.label } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "TABLE_TRANSFER", entityType: "Order", entityId: orderId, before: { tableId: order.tableId }, after: { tableId, table: table.label } } });
      });
    } else if (action === "void") {
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
      if (reason.length < 3) return NextResponse.json({ error: "A reason is required to void an order." }, { status: 400 });
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) return NextResponse.json({ error: "This order cannot be voided in its current state." }, { status: 409 });
      if (order.bill?.payments.some((payment) => payment.status === "PAID")) return NextResponse.json({ error: "A paid order requires a refund/reversal before it can be voided." }, { status: 409 });
      await prisma.$transaction(async (tx) => {
        const changed = await tx.order.updateMany({ where: { id: orderId, tenantId: access.tenantId, outletId, status: order.status }, data: { status: OrderStatus.CANCELLED } });
        if (changed.count !== 1) throw new RangeError("Order changed concurrently; reload before retrying.");
        await tx.kOT.updateMany({ where: { orderId, status: { not: KOTStatus.SERVED } }, data: { status: KOTStatus.CANCELLED } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "ORDER_VOIDED", entityType: "Order", entityId: orderId, before: { status: order.status }, after: { status: OrderStatus.CANCELLED }, reason } });
      });
    } else {
      return NextResponse.json({ error: "Supported actions are kot-ready, kot-served, transfer-table, and void." }, { status: 400 });
    }
    const updated = await prisma.order.findFirst({ where: { id: orderId, tenantId: access.tenantId, outletId }, include: { items: true, kots: { include: { items: true } }, bill: { include: { payments: true } } } });
    void publishOutletEvent(access.tenantId, outletId, action.startsWith("kot-") ? "kot:status" : "order:updated", { orderId, action });
    return NextResponse.json({ order: safeJson(updated) });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Could not update order." }, { status: 500 });
  }
}
