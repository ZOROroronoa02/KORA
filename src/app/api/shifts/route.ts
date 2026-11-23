import { NextRequest, NextResponse } from "next/server";
import { Prisma, ShiftStatus } from "@prisma/client";
import { authorizeOutlet } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { reconcileCash } from "@/lib/billing";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
class ShiftConflictError extends Error {}

export async function GET(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await authorizeOutlet(request, outletId, "shift.open");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const shift = await prisma.shift.findFirst({ where: { tenantId: access.tenantId, outletId, userId: access.user.id, status: ShiftStatus.OPEN }, orderBy: { openedAt: "desc" } });
  return NextResponse.json({ shift: safeJson(shift) });
}

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const action = body.action;
    const permission = action === "close" ? "shift.close" : "shift.open";
    const access = await authorizeOutlet(request, outletId, permission);
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (action === "open") {
      const openingCashPaise = Number(body.openingCashPaise);
      if (!Number.isSafeInteger(openingCashPaise) || openingCashPaise < 0) return NextResponse.json({ error: "Opening cash must be a non-negative paise amount." }, { status: 400 });
      const shift = await prisma.$transaction(async (tx) => {
        const active = await tx.shift.findFirst({ where: { tenantId: access.tenantId, outletId, userId: access.user.id, status: ShiftStatus.OPEN }, select: { id: true } });
        if (active) throw new ShiftConflictError("You already have an open shift.");
        const created = await tx.shift.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, status: ShiftStatus.OPEN, activeKey: "OPEN", openingCashPaise: BigInt(openingCashPaise) } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "SHIFT_OPENED", entityType: "Shift", entityId: created.id, after: { openingCashPaise } } });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      void publishOutletEvent(access.tenantId, outletId, "shift:updated", { shiftId: shift.id, status: "OPEN" });
      return NextResponse.json({ shift: safeJson(shift) }, { status: 201 });
    }
    if (action !== "close") return NextResponse.json({ error: "Action must be open or close." }, { status: 400 });
    const countedCashPaise = Number(body.countedCashPaise);
    if (!Number.isSafeInteger(countedCashPaise) || countedCashPaise < 0) return NextResponse.json({ error: "Counted cash must be a non-negative paise amount." }, { status: 400 });
    const { shift, totals } = await prisma.$transaction(async (tx) => {
      const active = await tx.shift.findFirst({ where: { tenantId: access.tenantId, outletId, userId: access.user.id, status: ShiftStatus.OPEN }, orderBy: { openedAt: "desc" } });
      if (!active) throw new ShiftConflictError("No open shift to close.");
      const cashTotal = await tx.payment.aggregate({ where: { shiftId: active.id, method: "CASH", status: "PAID" }, _sum: { amountPaise: true } });
      const opening = active.openingCashPaise;
      const paid = cashTotal._sum.amountPaise ?? 0n;
      if (opening > BigInt(Number.MAX_SAFE_INTEGER) || paid > BigInt(Number.MAX_SAFE_INTEGER) || opening + paid > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Cash total exceeds supported reconciliation range.");
      const totals = reconcileCash(Number(opening), [Number(paid)], countedCashPaise);
      const closedAt = new Date();
      const result = await tx.shift.updateMany({ where: { id: active.id, status: ShiftStatus.OPEN, activeKey: "OPEN" }, data: { status: ShiftStatus.CLOSED, activeKey: null, expectedCashPaise: BigInt(totals.expectedCashPaise), countedCashPaise: BigInt(totals.countedCashPaise), variancePaise: BigInt(totals.variancePaise), closedAt } });
      if (result.count !== 1) throw new ShiftConflictError("Shift was closed by another request.");
      const shift = await tx.shift.findUniqueOrThrow({ where: { id: active.id } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "SHIFT_CLOSED", entityType: "Shift", entityId: shift.id, before: { status: "OPEN" }, after: safeJson(totals) } });
      return { shift, totals };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    void publishOutletEvent(access.tenantId, outletId, "shift:updated", { shiftId: shift.id, status: "CLOSED", reconciliation: totals });
    return NextResponse.json({ shift: safeJson(shift), reconciliation: totals });
  } catch (error) {
    if (error instanceof ShiftConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (typeof error === "object" && error && "code" in error && (error.code === "P2002" || error.code === "P2034")) return NextResponse.json({ error: "Shift changed concurrently. Reload and retry." }, { status: 409 });
    return NextResponse.json({ error: "Could not update shift." }, { status: 500 });
  }
}
