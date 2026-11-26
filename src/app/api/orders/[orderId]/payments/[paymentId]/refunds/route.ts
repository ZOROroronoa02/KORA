import { NextRequest, NextResponse } from "next/server";
import { PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { addRefundWithinPaidBalance, paymentStatusAfterRefund } from "@/lib/billing";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { isTransactionConflict } from "@/lib/db-conflicts";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
type RefundPayload = { orderId: string; paymentId: string; amountPaise: number; reason: string; reference: string | null };
function matchesRefundPayload(value: unknown, expected: RefundPayload) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const saved = value as Partial<RefundPayload>;
  return saved.orderId === expected.orderId && saved.paymentId === expected.paymentId
    && saved.amountPaise === expected.amountPaise && saved.reason === expected.reason && saved.reference === expected.reference;
}

async function POSTHandler(request: NextRequest, context: { params: Promise<{ orderId: string; paymentId: string }> }) {
  let outletId = "";
  let deviceId = "";
  let clientMutationId = "";
  let payload: RefundPayload | undefined;
  try {
    const { orderId, paymentId } = await context.params;
    const body = await readJsonObject(request, 8 * 1024);
    outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const access = await requirePermission(request, outletId, "bills.refund");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

    deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    clientMutationId = typeof body.clientMutationId === "string" ? body.clientMutationId.trim() : "";
    const amountPaise = Number(body.amountPaise);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    const reference = typeof body.reference === "string" ? body.reference.trim().slice(0, 160) || null : null;
    if (!/^[\w-]{1,120}$/.test(deviceId) || !/^[\w-]{16,150}$/.test(clientMutationId) || !Number.isSafeInteger(amountPaise) || amountPaise <= 0 || reason.length < 3) {
      return NextResponse.json({ error: "Provide a valid device, unique mutation ID, positive refund amount in paise, and a reason of at least 3 characters." }, { status: 400 });
    }
    const refundPayload: RefundPayload = { orderId, paymentId, amountPaise, reason, reference };
    payload = refundPayload;

    const prior = await prisma.syncMutation.findUnique({ where: { deviceId_clientMutationId: { deviceId, clientMutationId } } });
    if (prior) {
      if (prior.outletId !== outletId || prior.operation !== "PAYMENT_REFUND" || !matchesRefundPayload(prior.payload, refundPayload)) {
        return NextResponse.json({ error: "This refund mutation ID was already used for another request." }, { status: 409 });
      }
      const result = prior.result as { reversalId?: string } | null;
      const reversal = result?.reversalId ? await prisma.paymentReversal.findFirst({ where: { id: result.reversalId, tenantId: access.tenantId, outletId } }) : null;
      if (!reversal) return NextResponse.json({ error: "The prior refund is still reconciling; retry with the same mutation ID." }, { status: 409 });
      return NextResponse.json({ reversal: safeJson(reversal), replayed: true });
    }

    const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: access.tenantId, outletId }, select: { id: true, status: true, bill: { select: { id: true } } } });
    if (!order?.bill) return NextResponse.json({ error: "Order bill not found." }, { status: 404 });
    if (order.status === "CANCELLED") return NextResponse.json({ error: "A cancelled order cannot accept a refund." }, { status: 409 });

    const saved = await prisma.$transaction(async (tx) => {
      const billLock = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "bills" WHERE "id" = ${order.bill!.id} AND "tenantId" = ${access.tenantId} AND "outletId" = ${outletId} FOR UPDATE`;
      if (!billLock.length) throw new ReferenceError("Order bill not found.");
      const currentOrder = await tx.order.findFirst({ where: { id: orderId, tenantId: access.tenantId, outletId }, select: { status: true } });
      if (!currentOrder || currentOrder.status === "CANCELLED") throw new RangeError("A cancelled order cannot accept a refund.");
      const bill = await tx.bill.findFirst({ where: { id: order.bill!.id, tenantId: access.tenantId, outletId, orderId } });
      const payment = await tx.payment.findFirst({ where: { id: paymentId, billId: order.bill!.id, status: PaymentStatus.PAID }, include: { reversals: true } });
      if (!bill || !payment) throw new ReferenceError("Successful source payment not found.");
      if (payment.method === PaymentMethod.OTHER) throw new RangeError("Refunds are not supported for this payment method.");
      if (payment.amountPaise > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Source payment exceeds the supported refund range.");
      const alreadyRefunded = payment.reversals.reduce((sum, reversal) => sum + reversal.amountPaise, 0n);
      if (alreadyRefunded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Source payment refund total exceeds the supported range.");
      addRefundWithinPaidBalance(Number(payment.amountPaise), Number(alreadyRefunded), amountPaise);

      let shiftId: string | undefined;
      if (payment.method === PaymentMethod.CASH) {
        const shift = await tx.shift.findFirst({ where: { tenantId: access.tenantId, outletId, userId: access.user.id, status: "OPEN" }, orderBy: { openedAt: "desc" }, select: { id: true, openingCashPaise: true } });
        if (!shift) throw new RangeError("Open a cashier shift before recording a cash refund.");
        const lockedShift = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "shifts" WHERE "id" = ${shift.id} AND "tenantId" = ${access.tenantId} AND "outletId" = ${outletId} AND "status" = 'OPEN' FOR UPDATE`;
        if (!lockedShift.length) throw new RangeError("The cashier shift closed before this refund could be recorded. Reload and retry.");
        const [cashPayments, cashRefunds] = await Promise.all([
          tx.payment.aggregate({ where: { shiftId: shift.id, method: PaymentMethod.CASH, status: PaymentStatus.PAID }, _sum: { amountPaise: true } }),
          tx.paymentReversal.aggregate({ where: { shiftId: shift.id, method: PaymentMethod.CASH }, _sum: { amountPaise: true } }),
        ]);
        const available = shift.openingCashPaise + (cashPayments._sum.amountPaise ?? 0n) - (cashRefunds._sum.amountPaise ?? 0n);
        if (available < BigInt(amountPaise)) throw new RangeError("Cash drawer does not have enough recorded cash for this refund.");
        shiftId = shift.id;
      }

      const grossPayments = await tx.payment.aggregate({ where: { billId: bill.id, status: PaymentStatus.PAID }, _sum: { amountPaise: true } });
      const allRefunds = await tx.paymentReversal.aggregate({ where: { payment: { billId: bill.id } }, _sum: { amountPaise: true } });
      const grossPaidPaise = grossPayments._sum.amountPaise ?? 0n;
      const totalRefundedPaise = allRefunds._sum.amountPaise ?? 0n;
      if (bill.totalPaise > BigInt(Number.MAX_SAFE_INTEGER) || grossPaidPaise > BigInt(Number.MAX_SAFE_INTEGER) || totalRefundedPaise > BigInt(Number.MAX_SAFE_INTEGER) || totalRefundedPaise > grossPaidPaise) {
        throw new RangeError("Bill payment balance exceeds the supported refund range.");
      }
      const nextBillRefunded = totalRefundedPaise + BigInt(amountPaise);
      if (nextBillRefunded > grossPaidPaise) throw new RangeError("Refund exceeds total captured payments for this bill.");
      const nextStatus = paymentStatusAfterRefund(Number(bill.totalPaise), Number(grossPaidPaise), Number(nextBillRefunded)) as PaymentStatus;

      await tx.syncMutation.create({ data: { tenantId: access.tenantId, outletId, deviceId, clientMutationId, operation: "PAYMENT_REFUND", payload: refundPayload, status: "PENDING" } });
      const reversal = await tx.paymentReversal.create({ data: {
        tenantId: access.tenantId, outletId, paymentId, shiftId, createdById: access.user.id,
        method: payment.method, amountPaise: BigInt(amountPaise), reference, reason,
      } });
      await tx.bill.update({ where: { id: bill.id }, data: { paymentStatus: nextStatus } });
      await tx.syncMutation.update({ where: { deviceId_clientMutationId: { deviceId, clientMutationId } }, data: { status: "APPLIED", appliedAt: new Date(), result: { reversalId: reversal.id } } });
      await tx.auditLog.create({ data: {
        tenantId: access.tenantId, outletId, userId: access.user.id, action: "PAYMENT_REFUNDED", entityType: "Bill", entityId: bill.id,
        before: { paymentStatus: bill.paymentStatus, refundedPaise: Number(totalRefundedPaise) },
        after: { paymentId, reversalId: reversal.id, amountPaise, method: payment.method, paymentStatus: nextStatus, refundedPaise: Number(nextBillRefunded) },
        reason,
      } });
      return reversal;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    void publishOutletEvent(access.tenantId, outletId, "order:updated", { orderId, action: "payment-refunded" });
    return NextResponse.json({ reversal: safeJson(saved), replayed: false }, { status: 201 });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof ReferenceError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if ((typeof error === "object" && error && "code" in error && error.code === "P2002") || isTransactionConflict(error)) {
      if (deviceId && clientMutationId && payload) {
        const prior = await prisma.syncMutation.findUnique({ where: { deviceId_clientMutationId: { deviceId, clientMutationId } } }).catch(() => null);
        const result = prior?.result as { reversalId?: string } | null;
        if (prior?.outletId === outletId && prior.operation === "PAYMENT_REFUND" && matchesRefundPayload(prior.payload, payload) && result?.reversalId) {
          const reversal = await prisma.paymentReversal.findFirst({ where: { id: result.reversalId, tenantId: prior.tenantId, outletId } }).catch(() => null);
          if (reversal) return NextResponse.json({ reversal: safeJson(reversal), replayed: true });
        }
      }
      return NextResponse.json({ error: "Payment changed concurrently. Retry with the same mutation ID." }, { status: 409 });
    }
    console.error("KORA payment refund failed", error);
    return NextResponse.json({ error: "Could not record payment refund." }, { status: 500 });
  }
}

export const POST = withTenantScope(POSTHandler);
