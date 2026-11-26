import { NextRequest, NextResponse } from "next/server";
import { OrderStatus, OrderType, PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { authorizeAnyOutletPermission, requirePermission, verifyManagerApprovalPin, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { allocatePaise, calculateSale, indianFinancialYear, paymentStatus } from "@/lib/billing";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { requiresDiscountApproval, settingsForOutlet } from "@/lib/domain/discount-approval";
import { isTransactionConflict } from "@/lib/db-conflicts";

export const runtime = "nodejs";
const methods: Record<string, PaymentMethod> = { Cash: PaymentMethod.CASH, Card: PaymentMethod.CARD, UPI: PaymentMethod.UPI, Other: PaymentMethod.OTHER };
const types: Record<string, OrderType> = { "Dine in": OrderType.DINE_IN, Takeaway: OrderType.TAKEAWAY, Delivery: OrderType.DELIVERY, QR: OrderType.QR, Aggregator: OrderType.AGGREGATOR };
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
function redactOrder<T extends { subtotalPaise: unknown; items?: Array<Record<string, unknown>>; bill?: unknown }>(order: T) {
  return {
    ...order,
    subtotalPaise: undefined,
    discountPaise: undefined,
    taxPaise: undefined,
    serviceChargePaise: undefined,
    totalPaise: undefined,
    bill: undefined,
    items: order.items?.map(({ unitPricePaise: _unitPrice, discountPaise: _discount, totalPaise: _total, ...item }) => item),
  };
}
class ConflictError extends Error {}
async function withSerializableRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const serializationConflict = isTransactionConflict(error);
      if (!serializationConflict || attempt + 1 >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required" }, { status: 400 });
  const access = await authorizeAnyOutletPermission(request, outletId, ["reports.view.sales", "orders.read", "kds.view"]);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const visibility: "all" | "own" | "kitchen" = access.permissions.includes("reports.view.sales") || access.permissions.includes("bills.settle") ? "all" : access.permissions.includes("orders.read") ? "own" : "kitchen";
  const where: Prisma.OrderWhereInput = { tenantId: access.tenantId, outletId };
  if (visibility === "own") where.createdById = access.user.id;
  if (visibility === "kitchen") where.status = { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] };
  const orders = await prisma.order.findMany({ where, include: { items: true, table: { select: { id: true, label: true } }, customer: { select: { name: true } }, kots: { include: { items: true } }, bill: { include: { payments: { include: { reversals: true } } } } }, orderBy: { createdAt: "desc" }, take: 100 });
  const maySeeFinancials = access.permissions.includes("bills.settle") || access.permissions.includes("reports.view.financial");
  const safeOrders = maySeeFinancials ? orders : orders.map((order) => ({
    ...order,
    subtotalPaise: undefined, discountPaise: undefined, taxPaise: undefined, serviceChargePaise: undefined, totalPaise: undefined,
    bill: undefined,
    items: order.items.map(({ unitPricePaise: _unitPrice, discountPaise: _discount, totalPaise: _total, ...item }) => item),
  }));
  return NextResponse.json(jsonSafe(safeOrders));
}

async function POSTHandler(request: NextRequest) {
  let retryOutletId = "";
  let retryKey = "";
  let maySeeFinancials = false;
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    retryOutletId = outletId;
    const access = await requirePermission(request, outletId, "orders.create");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    maySeeFinancials = access.permissions.includes("bills.settle") || access.permissions.includes("reports.view.financial");
    const idempotencyKey = typeof body.clientMutationId === "string" ? body.clientMutationId.trim() : "";
    retryKey = idempotencyKey;
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "unknown-device";
    const type = typeof body.type === "string" ? types[body.type] : undefined;
    const inputItems: Array<{ menuItemId: string; quantity: unknown; note?: unknown }> = Array.isArray(body.items) ? body.items : [];
    if (!idempotencyKey || idempotencyKey.length > 150 || !type || inputItems.length < 1 || inputItems.length > 100) return NextResponse.json({ error: "A valid clientMutationId, order type, and 1–100 items are required." }, { status: 400 });
    const existing = await prisma.order.findUnique({ where: { outletId_idempotencyKey: { outletId, idempotencyKey } }, include: { items: true, bill: { include: { payments: { include: { reversals: true } } } }, kots: { include: { items: true } } } });
    if (existing) return NextResponse.json({ order: jsonSafe(maySeeFinancials ? existing : redactOrder(existing)), kot: jsonSafe(existing.kots.at(-1) ?? null), ...(maySeeFinancials ? { bill: jsonSafe(existing.bill) } : {}), replayed: true });
    const uniqueIds: string[] = [...new Set(inputItems.map((item) => typeof item.menuItemId === "string" ? item.menuItemId : ""))].filter((id) => id.length > 0);
    if (uniqueIds.length !== inputItems.length) return NextResponse.json({ error: "Every order line needs a menu item ID." }, { status: 400 });
    const outlet = await prisma.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId } });
    if (!outlet) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
    const products = await prisma.menuItem.findMany({ where: { id: { in: uniqueIds }, tenantId: access.tenantId, active: true }, include: { outletPrices: { where: { outletId } } } });
    if (products.length !== uniqueIds.length || products.some((p) => p.outletPrices.some((price) => !price.available))) return NextResponse.json({ error: "An item is unavailable or does not belong to this outlet." }, { status: 409 });
    const items = inputItems.map((input) => {
      const product = products.find((p) => p.id === input.menuItemId)!;
      const quantity = Number(input.quantity);
      const price = product.outletPrices[0]?.pricePaise ?? product.basePricePaise;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || price > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Invalid quantity or price");
      return { product, quantity, pricePaise: Number(price), note: typeof input.note === "string" ? input.note.slice(0, 300) : undefined };
    });
    const requestedDiscountBps = Number(body.discountBps ?? 0);
    if (!Number.isInteger(requestedDiscountBps) || requestedDiscountBps < 0 || requestedDiscountBps > 10000) return NextResponse.json({ error: "Discount rate must be between 0 and 10000 basis points." }, { status: 400 });
    if (requestedDiscountBps > 0) {
      const permission = await requirePermission(request, outletId, "bills.discount.apply");
      if ("error" in permission) return NextResponse.json({ error: "Discount permission required." }, { status: 403 });
    }
    const paidPaise = Number(body.paidPaise ?? 0);
    if (!Number.isSafeInteger(paidPaise) || paidPaise < 0) return NextResponse.json({ error: "Payment must be a non-negative paise amount." }, { status: 400 });
    if (paidPaise > 0) {
      const settlement = await requirePermission(request, outletId, "bills.settle");
      if ("error" in settlement) return NextResponse.json({ error: "Bill settlement permission required." }, { status: 403 });
    }
    const settingsRow = await prisma.outletSettings.findUnique({ where: { outletId }, select: { settings: true } });
    const settings = settingsForOutlet(settingsRow?.settings);
    let approvalUserId: string | undefined;
    const thresholdPct = settings.discountApprovalThresholdPct ?? 10;
    if (requiresDiscountApproval(requestedDiscountBps, settings)) {
      const pin = typeof body.approvalPin === "string" ? body.approvalPin : "";
      approvalUserId = await verifyManagerApprovalPin({ outletId, pin, actorUserId: access.user.id, permission: "bills.discount.approve" }) ?? undefined;
      if (!approvalUserId) return NextResponse.json({ error: "A manager approval PIN is required for this discount." }, { status: 403 });
    }
    const saleLines = items.map((i) => ({ quantity: i.quantity, unitPricePaise: i.pricePaise, gstBps: i.product.gstBps }));
    const undiscounted = calculateSale(saleLines);
    const discountPaise = Number((BigInt(undiscounted.subtotalPaise) * BigInt(requestedDiscountBps) + 5000n) / 10000n);
    const itemDiscounts = allocatePaise(BigInt(discountPaise), items.map((item) => BigInt(item.pricePaise) * BigInt(item.quantity)));
    const totals = calculateSale(saleLines, { discountPaise, serviceChargeBps: type === OrderType.DINE_IN ? outlet.serviceChargeBps : 0 });
    if (paidPaise > totals.totalPaise) return NextResponse.json({ error: "Payment must be between zero and the bill total." }, { status: 400 });
    const paidStatus = paymentStatus(totals.totalPaise, paidPaise) as PaymentStatus;
    const method = typeof body.paymentMethod === "string" ? methods[body.paymentMethod] : undefined;
    if (paidPaise > 0 && !method) return NextResponse.json({ error: "A payment method is required for a recorded payment." }, { status: 400 });
    const customerId = typeof body.customerId === "string" ? body.customerId : undefined;
    const tableId = typeof body.tableId === "string" ? body.tableId : undefined;
    if (type === OrderType.DINE_IN && !tableId) return NextResponse.json({ error: "A table is required for dine-in orders." }, { status: 400 });
    if (type !== OrderType.DINE_IN && tableId) return NextResponse.json({ error: "Tables can only be assigned to dine-in orders." }, { status: 400 });
    const saved = await withSerializableRetry(() => prisma.$transaction(async (tx) => {
      if (customerId) {
        const customer = await tx.customer.findFirst({ where: { id: customerId, tenantId: access.tenantId } });
        if (!customer) throw new ReferenceError("Customer not found in this restaurant.");
      }
      if (tableId) {
        const lockedTables = await tx.$queryRaw<Array<{ id: string }>>`SELECT t."id" FROM "restaurant_tables" AS t JOIN "outlets" AS o ON o."id" = t."outletId" WHERE t."id" = ${tableId} AND o."tenantId" = ${access.tenantId} AND t."outletId" = ${outletId} AND t."active" = true FOR UPDATE OF t`;
        if (!lockedTables.length) throw new ReferenceError("Table not found in this outlet.");
        const occupied = await tx.order.findFirst({ where: { outletId, tableId, status: { in: ["OPEN", "SENT", "PREPARING", "READY", "SERVED"] } }, select: { id: true } });
        if (occupied) throw new ConflictError("Table already has an active order.");
      }
      const activeShift = await tx.shift.findFirst({ where: { tenantId: access.tenantId, outletId, userId: access.user.id, status: "OPEN" }, orderBy: { openedAt: "desc" } });
      if (paidPaise > 0 && method === PaymentMethod.CASH && !activeShift) throw new ConflictError("Open a cashier shift before recording cash payment.");
      const stationRows = await tx.station.findMany({ where: { outletId, active: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } });
      const defaultStation = stationRows.find((station) => station.name === "General") ?? stationRows[0] ?? null;
      const sequence = await tx.outlet.update({ where: { id: outletId }, data: { orderNextNumber: { increment: 1 } }, select: { orderNextNumber: true, invoicePrefix: true } });
      const fiscalYear = indianFinancialYear(new Date());
      const invoiceCounter = await tx.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { invoiceFinancialYear: true, invoiceNextNumber: true } });
      let invoiceSequenceNumber = invoiceCounter.invoiceNextNumber;
      if (invoiceCounter.invoiceFinancialYear !== fiscalYear.label) {
        const financialYearStart = new Date(Date.UTC(fiscalYear.startYear, 3, 1) - 330 * 60 * 1000);
        const nextFinancialYearStart = new Date(Date.UTC(fiscalYear.startYear + 1, 3, 1) - 330 * 60 * 1000);
        const existingInvoiceSequence = await tx.$queryRaw<Array<{ maxSequence: number | null }>>`
          SELECT MAX(substring("invoiceNumber" from '-([0-9]+)$')::integer) AS "maxSequence"
          FROM "bills"
          WHERE "tenantId" = ${access.tenantId}
            AND "outletId" = ${outletId}
            AND "issuedAt" >= ${financialYearStart}
            AND "issuedAt" < ${nextFinancialYearStart}
            AND "invoiceNumber" ~ '-[0-9]+$'
        `;
        invoiceSequenceNumber = (existingInvoiceSequence[0]?.maxSequence ?? 0) + 1;
      }
      if (!Number.isSafeInteger(invoiceSequenceNumber) || invoiceSequenceNumber < 1 || invoiceSequenceNumber >= 2_147_483_647) {
        throw new RangeError("Invoice sequence is outside the supported range.");
      }
      await tx.outlet.update({ where: { id: outletId }, data: { invoiceFinancialYear: fiscalYear.label, invoiceNextNumber: invoiceSequenceNumber + 1 } });
      const invoiceNumber = `${sequence.invoicePrefix}-FY${fiscalYear.label}-${String(invoiceSequenceNumber).padStart(6, "0")}`;
      const order = await tx.order.create({ data: {
        tenantId: access.tenantId, outletId, orderNumber: sequence.orderNextNumber - 1, type, status: "PREPARING", customerId, tableId, createdById: access.user.id,
        deviceId, idempotencyKey, subtotalPaise: BigInt(totals.subtotalPaise), discountPaise: BigInt(totals.discountPaise), taxPaise: BigInt(totals.taxPaise), serviceChargePaise: BigInt(totals.serviceChargePaise), totalPaise: BigInt(totals.totalPaise),
        items: { create: items.map((i, index) => ({ menuItemId: i.product.id, nameSnapshot: i.product.name, quantity: i.quantity, unitPricePaise: BigInt(i.pricePaise), gstBps: i.product.gstBps, discountPaise: itemDiscounts[index], totalPaise: BigInt(i.pricePaise * i.quantity) - itemDiscounts[index], notes: i.note })) },
      }, include: { items: true } });
      const tableLabel = tableId ? (await tx.restaurantTable.findUnique({ where: { id: tableId }, select: { label: true } }))?.label ?? null : null;
      const routedItems = order.items.map((orderItem, index) => ({ orderItem, stationId: items[index].product.outletPrices[0]?.stationId ?? defaultStation?.id ?? null }));
      const grouped = new Map<string, typeof routedItems>();
      for (const entry of routedItems) {
        const key = entry.stationId ?? "";
        const group = grouped.get(key) ?? [];
        group.push(entry);
        grouped.set(key, group);
      }
      const kotCount = grouped.size;
      const kotSequence = await tx.outlet.update({ where: { id: outletId }, data: { kotNextNumber: { increment: kotCount } }, select: { kotNextNumber: true } });
      const firstKotNumber = kotSequence.kotNextNumber - kotCount;
      const kots = [];
      let groupIndex = 0;
      for (const [stationKey, lines] of grouped) {
        const kot = await tx.kOT.create({ data: {
          orderId: order.id, outletId, stationId: stationKey || null, sequence: groupIndex + 1,
          kotNumber: firstKotNumber + groupIndex, orderType: type, tableLabel, waiterName: access.user.name,
          notes: typeof body.kitchenNote === "string" ? body.kitchenNote.trim().slice(0, 300) : null,
          items: { create: lines.map(({ orderItem }) => ({ orderItemId: orderItem.id, quantity: orderItem.quantity, state: "QUEUED" })) },
        }, include: { items: true } });
        kots.push(kot);
        groupIndex++;
      }
      const bill = await tx.bill.create({ data: {
        tenantId: access.tenantId, outletId, orderId: order.id, invoiceNumber, subtotalPaise: BigInt(totals.subtotalPaise), discountPaise: BigInt(totals.discountPaise), taxablePaise: BigInt(totals.taxablePaise),
        cgstPaise: BigInt(Math.floor(totals.taxPaise / 2)), sgstPaise: BigInt(totals.taxPaise - Math.floor(totals.taxPaise / 2)), serviceChargePaise: BigInt(totals.serviceChargePaise), totalPaise: BigInt(totals.totalPaise), paymentStatus: paidStatus,
        payments: paidPaise > 0 ? { create: { method: method!, amountPaise: BigInt(paidPaise), status: PaymentStatus.PAID, shiftId: activeShift?.id } } : undefined,
      }, include: { payments: true } });
      if (customerId) await tx.customerOutlet.upsert({
        where: { customerId_outletId: { customerId, outletId } },
        update: { lastVisitAt: new Date(), visits: { increment: 1 }, spendPaise: { increment: BigInt(totals.totalPaise) } },
        create: { customerId, outletId, visits: 1, spendPaise: BigInt(totals.totalPaise) },
      });
      if (discountPaise > 0) await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, approvalUserId, action: "ORDER_DISCOUNT", entityType: "Order", entityId: order.id, after: { discountPaise, discountBps: requestedDiscountBps, thresholdPct } } });
      return { order, kots, kot: kots[0], bill };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    void publishOutletEvent(access.tenantId, outletId, "order:new", { orderId: saved.order.id, orderNumber: saved.order.orderNumber, kotId: saved.kot?.id });
    for (const ticket of saved.kots) void publishOutletEvent(access.tenantId, outletId, "kot:created", { ticketId: ticket.id, kotNumber: ticket.kotNumber, orderId: saved.order.id });
    const result = maySeeFinancials ? saved : { ...saved, order: redactOrder(saved.order), bill: undefined };
    return NextResponse.json({ ...jsonSafe(result), replayed: false }, { status: 201 });
  } catch (error) {
    if (error instanceof ConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof ReferenceError) return NextResponse.json({ error: error.message }, { status: 404 });
    if ((typeof error === "object" && error && "code" in error && error.code === "P2002") || isTransactionConflict(error)) {
      if (retryOutletId && retryKey) {
        const existing = await prisma.order.findUnique({ where: { outletId_idempotencyKey: { outletId: retryOutletId, idempotencyKey: retryKey } }, include: { items: true, bill: { include: { payments: { include: { reversals: true } } } }, kots: { include: { items: true } } } }).catch(() => null);
        if (existing) return NextResponse.json({ order: jsonSafe(maySeeFinancials ? existing : redactOrder(existing)), kot: jsonSafe(existing.kots.at(-1) ?? null), ...(maySeeFinancials ? { bill: jsonSafe(existing.bill) } : {}), replayed: true });
      }
      return NextResponse.json({ error: "A conflicting order already exists. Retry with its original clientMutationId." }, { status: 409 });
    }
    console.error("KORA order creation failed", error);
    return NextResponse.json({ error: "Could not create order." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
