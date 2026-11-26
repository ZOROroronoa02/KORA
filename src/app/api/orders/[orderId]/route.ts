import { NextRequest, NextResponse } from "next/server";
import { KOTStatus, OrderStatus, Prisma } from "@prisma/client";
import { requirePermission, verifyManagerApprovalPin, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { publishOutletEvent } from "@/lib/realtime";
import { transitionOrder } from "@/lib/billing";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { isTransactionConflict } from "@/lib/db-conflicts";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

async function PATCHHandler(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await context.params;
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const action = typeof body.action === "string" ? body.action : "";
    const permission = action === "kot-ready" || action === "kot-served" ? "kds.bump" : action === "void" ? "orders.void" : action === "transfer-table" ? "orders.move_table" : "orders.edit";
    const access = await requirePermission(request, outletId, permission);
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const order = await prisma.order.findFirst({
      where: { id: orderId, outletId, tenantId: access.tenantId },
      include: { items: true, kots: { include: { items: true } }, bill: { include: { payments: { include: { reversals: true } } } } },
    });
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
        const now = new Date();
        const kots = await tx.kOT.updateMany({ where: { orderId, status: { in: activeKotStates } }, data: { status, ...(status === KOTStatus.READY ? { readyAt: now } : {}), ...(status === KOTStatus.SERVED ? { servedAt: now } : {}) } });
        if (kots.count === 0) throw new RangeError("No active kitchen ticket can make this transition.");
        await tx.kOTItem.updateMany({ where: { kot: { orderId, status } }, data: { status, state: status === KOTStatus.READY ? "READY" : "BUMPED" } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: status === KOTStatus.READY ? "KOT_READY" : "ORDER_SERVED", entityType: "Order", entityId: orderId, before: { status: order.status }, after: { status: orderStatus } } });
      });
    } else if (action === "transfer-table") {
      if (order.type !== "DINE_IN") return NextResponse.json({ error: "Only dine-in orders can be transferred between tables." }, { status: 409 });
      const tableId = typeof body.tableId === "string" ? body.tableId : "";
      const table = await prisma.restaurantTable.findFirst({ where: { id: tableId, outletId, active: true } });
      if (!table) return NextResponse.json({ error: "Target table not found." }, { status: 404 });
      if (order.tableId === table.id) return NextResponse.json({ order: safeJson(order), unchanged: true });
      await prisma.$transaction(async (tx) => {
        const lockedTable = await tx.$queryRaw<Array<{ id: string }>>`SELECT t."id" FROM "restaurant_tables" AS t JOIN "outlets" AS o ON o."id" = t."outletId" WHERE t."id" = ${tableId} AND o."tenantId" = ${access.tenantId} AND t."outletId" = ${outletId} AND t."active" = true FOR UPDATE OF t`;
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
      const setting = await prisma.outletSettings.findUnique({ where: { outletId }, select: { settings: true } });
      const config = setting?.settings && typeof setting.settings === "object" && !Array.isArray(setting.settings) ? setting.settings as Record<string, unknown> : {};
      let approvalUserId: string | undefined;
      if (config.voidRequiresApproval === true) {
        approvalUserId = await verifyManagerApprovalPin({ outletId, pin: typeof body.approvalPin === "string" ? body.approvalPin : "", actorUserId: access.user.id, permission: "bills.void" }) ?? undefined;
        if (!approvalUserId) return NextResponse.json({ error: "A separate manager approval PIN is required to void this order." }, { status: 403 });
      }
      await prisma.$transaction(async (tx) => {
        if (order.bill) {
          const billLock = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "bills" WHERE "id" = ${order.bill.id} AND "tenantId" = ${access.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
          if (!billLock.length) throw new RangeError("Order bill no longer exists.");
          const grossPayments = await tx.payment.aggregate({ where: { billId: order.bill.id, status: "PAID" }, _sum: { amountPaise: true } });
          const reversals = await tx.paymentReversal.aggregate({ where: { payment: { billId: order.bill.id } }, _sum: { amountPaise: true } });
          const grossPaidPaise = grossPayments._sum.amountPaise ?? 0n;
          const refundedPaise = reversals._sum.amountPaise ?? 0n;
          if (grossPaidPaise > BigInt(Number.MAX_SAFE_INTEGER) || refundedPaise > grossPaidPaise) throw new RangeError("Payment balance exceeds the supported range.");
          if (grossPaidPaise > refundedPaise) throw new RangeError("A paid order must be fully refunded before it can be voided.");
        }
        const changed = await tx.order.updateMany({ where: { id: orderId, tenantId: access.tenantId, outletId, status: order.status }, data: { status: OrderStatus.CANCELLED } });
        if (changed.count !== 1) throw new RangeError("Order changed concurrently; reload before retrying.");
        await tx.kOT.updateMany({ where: { orderId, status: { not: KOTStatus.SERVED } }, data: { status: KOTStatus.CANCELLED } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, approvalUserId, action: "ORDER_VOIDED", entityType: "Order", entityId: orderId, before: { status: order.status }, after: { status: OrderStatus.CANCELLED }, reason } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } else {
      return NextResponse.json({ error: "Supported actions are kot-ready, kot-served, transfer-table, and void." }, { status: 400 });
    }
    const updated = await prisma.order.findFirst({
      where: { id: orderId, tenantId: access.tenantId, outletId },
      include: { items: true, kots: { include: { items: true } }, bill: { include: { payments: { include: { reversals: true } } } } },
    });
    void publishOutletEvent(access.tenantId, outletId, action.startsWith("kot-") ? "kot:status" : "order:updated", { orderId, action });
    const maySeeFinancials = access.permissions.includes("bills.settle") || access.permissions.includes("reports.view.financial");
    const safeOrder = updated && !maySeeFinancials ? {
      ...updated,
      subtotalPaise: undefined, discountPaise: undefined, taxPaise: undefined, serviceChargePaise: undefined, totalPaise: undefined,
      bill: undefined,
      items: updated.items.map(({ unitPricePaise: _unitPrice, discountPaise: _discount, totalPaise: _total, ...item }) => item),
    } : updated;
    return NextResponse.json({ order: safeJson(safeOrder) });
  } catch (error) {
    if (isTransactionConflict(error)) return NextResponse.json({ error: "Order changed concurrently. Reload before retrying." }, { status: 409 });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not update order." }, { status: 500 });
  }
}

export const PATCH = withTenantScope(PATCHHandler);
