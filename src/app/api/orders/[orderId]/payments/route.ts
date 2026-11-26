import { NextRequest, NextResponse } from "next/server";
import { PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { paymentStatus } from "@/lib/billing";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const methods: Record<string, PaymentMethod> = { Cash: PaymentMethod.CASH, Card: PaymentMethod.CARD, UPI: PaymentMethod.UPI };
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

export async function POST(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  let outletId = "";
  let deviceId = "";
  let clientMutationId = "";
  try {
    const { orderId } = await context.params;
    const body = await readJsonObject(request);
    outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "bills.settle");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    clientMutationId = typeof body.clientMutationId === "string" ? body.clientMutationId.trim() : "";
    const amountPaise = Number(body.amountPaise);
    const method = typeof body.method === "string" ? methods[body.method] : undefined;
    if (!deviceId || deviceId.length > 120 || !clientMutationId || clientMutationId.length > 150 || !Number.isSafeInteger(amountPaise) || amountPaise <= 0 || !method) {
      return NextResponse.json({ error: "Provide a device, unique payment mutation ID, positive amount in paise, and payment method." }, { status: 400 });
    }
    const order = await prisma.order.findFirst({ where: { id: orderId, outletId, tenantId: access.tenantId }, include: { bill: true } });
    if (!order?.bill) return NextResponse.json({ error: "Order bill not found." }, { status: 404 });
    if (order.status === "CANCELLED") return NextResponse.json({ error: "A cancelled order cannot accept payment." }, { status: 409 });

    const payload = { orderId, amountPaise, method };
    const prior = await prisma.syncMutation.findUnique({ where: { deviceId_clientMutationId: { deviceId, clientMutationId } } });
    if (prior) {
      const saved = prior.payload as typeof payload;
      if (prior.outletId !== outletId || prior.operation !== "PAYMENT_RECORD" || saved.orderId !== orderId || saved.amountPaise !== amountPaise || saved.method !== method) {
        return NextResponse.json({ error: "This payment mutation ID was already used for a different request." }, { status: 409 });
      }
      const result = prior.result as { paymentId?: string } | null;
      const payment = result?.paymentId ? await prisma.payment.findUnique({ where: { id: result.paymentId } }) : null;
      return NextResponse.json({ payment: safeJson(payment), replayed: true });
    }

    const saved = await prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findFirst({ where: { id: order.bill!.id, tenantId: access.tenantId, outletId, orderId } });
      if (!bill) throw new ReferenceError("Order bill not found.");
      const paid = await tx.payment.aggregate({ where: { billId: bill.id, status: PaymentStatus.PAID }, _sum: { amountPaise: true } });
      const paidPaise = paid._sum.amountPaise ?? 0n;
      if (bill.totalPaise > BigInt(Number.MAX_SAFE_INTEGER) || paidPaise > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Bill amount exceeds supported payment range.");
      const nextPaid = Number(paidPaise) + amountPaise;
      const nextStatus = paymentStatus(Number(bill.totalPaise), nextPaid) as PaymentStatus;
      let shiftId: string | undefined;
      if (method === PaymentMethod.CASH) {
        const shift = await tx.shift.findFirst({ where: { tenantId: access.tenantId, outletId, userId: access.user.id, status: "OPEN" }, orderBy: { openedAt: "desc" }, select: { id: true } });
        if (!shift) throw new RangeError("Open a cashier shift before recording cash payment.");
        shiftId = shift.id;
      }
      await tx.syncMutation.create({ data: { tenantId: access.tenantId, outletId, deviceId, clientMutationId, operation: "PAYMENT_RECORD", payload, status: "PENDING" } });
      const payment = await tx.payment.create({ data: { billId: bill.id, shiftId, method, amountPaise: BigInt(amountPaise), status: PaymentStatus.PAID } });
      await tx.bill.update({ where: { id: bill.id }, data: { paymentStatus: nextStatus } });
      await tx.syncMutation.update({ where: { deviceId_clientMutationId: { deviceId, clientMutationId } }, data: { status: "APPLIED", appliedAt: new Date(), result: { paymentId: payment.id } } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "PAYMENT_RECORDED", entityType: "Bill", entityId: bill.id, before: { paymentStatus: bill.paymentStatus }, after: { amountPaise, method, paymentStatus: nextStatus } } });
      return payment;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    void publishOutletEvent(access.tenantId, outletId, "order:updated", { orderId, action: "payment-recorded" });
    return NextResponse.json({ payment: safeJson(saved), replayed: false }, { status: 201 });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof ReferenceError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (typeof error === "object" && error && "code" in error && (error.code === "P2002" || error.code === "P2034")) {
      if (deviceId && clientMutationId) {
        const prior = await prisma.syncMutation.findUnique({ where: { deviceId_clientMutationId: { deviceId, clientMutationId } } }).catch(() => null);
        const result = prior?.result as { paymentId?: string } | null;
        const payment = prior?.operation === "PAYMENT_RECORD" && result?.paymentId ? await prisma.payment.findUnique({ where: { id: result.paymentId } }).catch(() => null) : null;
        if (payment) return NextResponse.json({ payment: safeJson(payment), replayed: true });
      }
      return NextResponse.json({ error: "Payment changed concurrently. Retry with the same mutation ID." }, { status: 409 });
    }
    console.error("KORA payment recording failed", error);
    return NextResponse.json({ error: "Could not record payment." }, { status: 500 });
  }
}
