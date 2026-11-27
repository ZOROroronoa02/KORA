import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { allocatePaise, calculateSale, paymentStatusAfterRefund } from "@/lib/billing";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { isTransactionConflict } from "@/lib/db-conflicts";
import { gstProfileDefaults, gstRateForItem, gstStateCodeForName, hasInvoiceAddress } from "@/lib/domain/gst-profile";
import { consumeRecipeStock, InsufficientRecipeStockError } from "@/lib/inventory-stock";

export const runtime = "nodejs";
class KdsOrderConflict extends Error { constructor(message: string) { super(message); this.name = "KdsOrderConflict"; } }
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

async function POSTHandler(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  let retry: { outletId: string; clientMutationId: string; requestHash: string; userId: string } | undefined;
  try {
    const { orderId } = await context.params;
    const body = await readJsonObject(request, 32 * 1024);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "orders.edit");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const printAccess = await requirePermission(request, outletId, "kot.print");
    if ("error" in printAccess) return NextResponse.json({ error: "KOT print permission is required to send added items to the kitchen." }, { status: 403 });
    const clientMutationId = typeof body.clientMutationId === "string" ? body.clientMutationId.trim() : "";
    const inputItems: Array<{ menuItemId?: unknown; quantity?: unknown; note?: unknown }> = Array.isArray(body.items) ? body.items : [];
    if (!/^[\w-]{16,100}$/.test(clientMutationId) || inputItems.length < 1 || inputItems.length > 50) return NextResponse.json({ error: "A valid clientMutationId and 1–50 new items are required." }, { status: 400 });
    const productIds = inputItems.map((item) => typeof item.menuItemId === "string" ? item.menuItemId : "");
    if (productIds.some((id) => !id) || new Set(productIds).size !== productIds.length) return NextResponse.json({ error: "Each added menu item must be unique and have a valid item ID." }, { status: 400 });
    const normalizedItems = inputItems.map((item) => {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new RangeError("Item quantities must be whole numbers from 1 to 999.");
      return { menuItemId: String(item.menuItemId), quantity, note: typeof item.note === "string" ? item.note.trim().slice(0, 300) : undefined };
    });
    const hashInput = { orderId, items: normalizedItems };
    const requestHash = createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
    retry = { outletId, clientMutationId, requestHash, userId: access.user.id };
    const prior = await prisma.kOTMutation.findUnique({ where: { outletId_clientMutationId: { outletId, clientMutationId } } });
    if (prior) {
      if (prior.userId !== access.user.id || prior.action !== "ORDER_ADD_ITEMS" || prior.requestHash !== requestHash) return NextResponse.json({ error: "clientMutationId was already used for another kitchen action." }, { status: 409 });
      return NextResponse.json({ ...(prior.response as Record<string, unknown> ?? {}), replayed: true });
    }

    const [outlet, products] = await Promise.all([
      prisma.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId }, select: { id: true, serviceChargeBps: true, tenant: { select: { gstProfile: true, gstRateBps: true } } } }),
      prisma.menuItem.findMany({ where: { id: { in: productIds }, tenantId: access.tenantId, active: true }, include: { outletPrices: { where: { outletId } } } }),
    ]);
    if (!outlet) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
    if (products.length !== productIds.length || products.some((product) => !product.outletPrices.length || !product.outletPrices[0].available)) return NextResponse.json({ error: "An added item is unavailable or does not belong to this outlet." }, { status: 409 });
    const lines = normalizedItems.map((input) => {
      const product = products.find((entry) => entry.id === input.menuItemId)!;
      const price = product.outletPrices[0].pricePaise ?? product.basePricePaise;
      if (price > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Item price exceeds the supported range.");
      return { input, product, pricePaise: Number(price) };
    });

    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "orders" WHERE "id" = ${orderId} AND "outletId" = ${outletId} AND "tenantId" = ${access.tenantId} FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { id: orderId, outletId, tenantId: access.tenantId }, include: { bill: { include: { payments: true } }, table: { select: { label: true } } } });
      if (!order) throw new KdsOrderConflict("Order not found in this outlet.");
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) throw new KdsOrderConflict("Completed or cancelled orders cannot receive new items.");
      const [existingKots, stationRows] = await Promise.all([
        tx.kOT.findMany({ where: { orderId, outletId }, select: { sequence: true } }),
        tx.station.findMany({ where: { outletId, active: true }, select: { id: true, name: true } }),
      ]);
      const generalStation = stationRows.find((station) => station.name === "General") ?? stationRows[0] ?? null;
      const profile = order.bill?.gstProfile ?? outlet.tenant.gstProfile;
      if (gstProfileDefaults[profile].documentType === "TAX_INVOICE" && lines.some((line) => !line.product.taxCodeKind || !line.product.taxCode)) {
        throw new KdsOrderConflict("Assign an HSN/SAC code to every added menu item before sending it to a tax-invoiced order.");
      }
      if (gstProfileDefaults[profile].documentType === "TAX_INVOICE" && order.type === "DELIVERY" && lines.some((line) => line.product.taxCodeKind === "HSN")) {
        const supplierAddress = order.bill?.supplierAddressSnapshot;
        const recipientAddress = order.bill?.recipientAddressSnapshot;
        if (!hasInvoiceAddress(recipientAddress)) throw new KdsOrderConflict("Enter the delivery address before adding packaged goods to this tax-invoiced delivery.");
        if (!hasInvoiceAddress(supplierAddress) || gstStateCodeForName(recipientAddress.state) !== gstStateCodeForName(supplierAddress.state)) {
          throw new KdsOrderConflict("Inter-state packaged-goods tax is not supported yet; KORA blocked the change to prevent a wrong invoice tax split.");
        }
      }
      const rateBps = order.bill?.gstRateBpsSnapshot ?? outlet.tenant.gstRateBps;
      const effectiveLines = lines.map((line) => ({ ...line, gstBps: gstRateForItem(profile, rateBps, line.product.gstBps) }));
      const serviceChargeBps = order.bill?.serviceChargeBpsSnapshot ?? (order.type === "DINE_IN" ? outlet.serviceChargeBps : 0);
      const rawSubtotal = effectiveLines.reduce((sum, line) => sum + line.pricePaise * line.input.quantity, 0);
      if (!Number.isSafeInteger(rawSubtotal)) throw new RangeError("Added item subtotal exceeds the supported range.");
      const lineDiscounts = effectiveLines.map(() => 0n);
      const additions = calculateSale(effectiveLines.map((line, index) => ({ quantity: line.input.quantity, unitPricePaise: line.pricePaise, gstBps: line.gstBps, discountPaise: Number(lineDiscounts[index]) })), { serviceChargeBps });
      const oldTotal = Number(order.totalPaise);
      const grossPaidPaise = order.bill?.payments.filter((payment) => payment.status === PaymentStatus.PAID).reduce((sum, payment) => sum + payment.amountPaise, 0n) ?? 0n;
      const refundAggregate = order.bill ? await tx.paymentReversal.aggregate({ where: { payment: { billId: order.bill.id } }, _sum: { amountPaise: true } }) : null;
      const refundedPaise = refundAggregate?._sum.amountPaise ?? 0n;
      if (grossPaidPaise > BigInt(Number.MAX_SAFE_INTEGER) || refundedPaise > grossPaidPaise) throw new RangeError("Payment balance exceeds the supported range.");
      const newTotal = oldTotal + additions.totalPaise;
      if (!Number.isSafeInteger(newTotal)) throw new RangeError("Updated order total exceeds the supported range.");
      const addedOrderItems = [];
      for (let index = 0; index < effectiveLines.length; index++) {
        const line = effectiveLines[index];
        const discount = lineDiscounts[index];
        const orderItem = await tx.orderItem.create({ data: {
          orderId, menuItemId: line.product.id, nameSnapshot: line.product.name, quantity: line.input.quantity,
          unitPricePaise: BigInt(line.pricePaise), gstBps: line.gstBps, taxCodeKindSnapshot: line.product.taxCodeKind, taxCodeSnapshot: line.product.taxCode, discountPaise: discount,
          totalPaise: BigInt(line.pricePaise * line.input.quantity) - discount, notes: line.input.note,
        } });
        addedOrderItems.push({ orderItem, menuItemId: line.product.id, stationId: line.product.outletPrices[0].stationId ?? generalStation?.id ?? null });
      }
      await consumeRecipeStock({
        tx,
        tenantId: access.tenantId,
        outletId,
        orderId,
        orderNumber: order.orderNumber,
        lines: addedOrderItems.map(({ orderItem, menuItemId }) => ({ orderItemId: orderItem.id, menuItemId, quantity: orderItem.quantity })),
      });
      const groups = new Map<string, typeof addedOrderItems>();
      for (const entry of addedOrderItems) {
        const key = entry.stationId ?? "";
        const group = groups.get(key) ?? [];
        group.push(entry);
        groups.set(key, group);
      }
      const nextKot = await tx.outlet.update({ where: { id: outletId }, data: { kotNextNumber: { increment: groups.size } }, select: { kotNextNumber: true } });
      const kotStart = nextKot.kotNextNumber - groups.size;
      const firstSequence = existingKots.reduce((highest, kot) => Math.max(highest, kot.sequence), 0) + 1;
      const createdKots = [];
      let offset = 0;
      for (const [stationKey, group] of groups) {
        const kot = await tx.kOT.create({ data: {
          orderId, outletId, stationId: stationKey || null, sequence: firstSequence + offset, kotNumber: kotStart + offset,
          orderType: order.type, tableLabel: order.table?.label ?? null, waiterName: access.user.name,
          notes: typeof body.kitchenNote === "string" ? body.kitchenNote.trim().slice(0, 300) : null,
          items: { create: group.map(({ orderItem }) => ({ orderItemId: orderItem.id, quantity: orderItem.quantity, state: "QUEUED" })) },
        } });
        createdKots.push(kot);
        offset++;
      }
      const updatedOrder = await tx.order.update({ where: { id: orderId }, data: {
        status: OrderStatus.PREPARING,
        subtotalPaise: { increment: BigInt(additions.subtotalPaise) }, discountPaise: { increment: BigInt(additions.discountPaise) },
        taxPaise: { increment: BigInt(additions.taxPaise) }, serviceChargePaise: { increment: BigInt(additions.serviceChargePaise) }, totalPaise: { increment: BigInt(additions.totalPaise) },
      }, select: { id: true, status: true, totalPaise: true } });
      if (order.bill) {
        await tx.bill.update({ where: { id: order.bill.id }, data: {
          subtotalPaise: { increment: BigInt(additions.subtotalPaise) }, discountPaise: { increment: BigInt(additions.discountPaise) },
          taxablePaise: { increment: BigInt(additions.taxablePaise) }, cgstPaise: { increment: BigInt(Math.floor(additions.taxPaise / 2)) },
          sgstPaise: { increment: BigInt(additions.taxPaise - Math.floor(additions.taxPaise / 2)) }, serviceChargePaise: { increment: BigInt(additions.serviceChargePaise) },
          totalPaise: { increment: BigInt(additions.totalPaise) }, paymentStatus: paymentStatusAfterRefund(newTotal, Number(grossPaidPaise), Number(refundedPaise)) as PaymentStatus,
        } });
      }
      const response = safeJson({ orderId: updatedOrder.id, orderStatus: updatedOrder.status, kotIds: createdKots.map((kot) => kot.id), kotNumbers: createdKots.map((kot) => kot.kotNumber) });
      await tx.kOTMutation.create({ data: { outletId, userId: access.user.id, clientMutationId, action: "ORDER_ADD_ITEMS", requestHash, response } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "ORDER_ITEMS_ADDED", entityType: "Order", entityId: orderId, before: { status: order.status, totalPaise: oldTotal }, after: { itemNames: lines.map((line) => line.product.name), quantities: lines.map((line) => line.input.quantity), totalPaise: newTotal, kotNumbers: createdKots.map((kot) => kot.kotNumber) } } });
      return { response, kots: createdKots.map((kot) => ({ id: kot.id, kotNumber: kot.kotNumber })), status: updatedOrder.status };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    for (const kot of saved.kots) void publishOutletEvent(access.tenantId, outletId, "kot:created", { ticketId: kot.id, kotNumber: kot.kotNumber, orderId, action: "items-added" });
    void publishOutletEvent(access.tenantId, outletId, "order:updated", { orderId, action: "items-added", status: saved.status });
    return NextResponse.json(saved.response, { status: 201 });
  } catch (error) {
    if (error instanceof KdsOrderConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof InsufficientRecipeStockError) return NextResponse.json({ error: error.message, shortages: error.shortages }, { status: 409 });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      if (retry) {
        const prior = await prisma.kOTMutation.findUnique({ where: { outletId_clientMutationId: { outletId: retry.outletId, clientMutationId: retry.clientMutationId } } }).catch(() => null);
        if (prior?.userId === retry.userId && prior.action === "ORDER_ADD_ITEMS" && prior.requestHash === retry.requestHash) return NextResponse.json({ ...(prior.response as Record<string, unknown> ?? {}), replayed: true });
      }
      return NextResponse.json({ error: "The clientMutationId was already used for another request." }, { status: 409 });
    }
    if (isTransactionConflict(error)) return NextResponse.json({ error: "Order changed while items were being added. Refresh and retry." }, { status: 409 });
    console.error("KORA order item append failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not add items to the order." }, { status: 500 });
  }
}

export const POST = withTenantScope(POSTHandler);
