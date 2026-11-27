import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus, Prisma } from "@prisma/client";
import { authorizeAnyOutletPermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { indiaDateString, MAX_REPORT_RANGE_DAYS, parseIndiaReportRange } from "@/lib/domain/report-dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requiredPermissions = ["reports.view.financial", "reports.view.staff_performance"] as const;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\t\r ]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvResponse(rows: Array<Record<string, unknown>>, from: string, to: string) {
  const columns = ["shift_id", "cashier", "status", "opened_at", "closed_at", "opening_cash_paise", "cash_captured_paise", "cash_refunded_paise", "expected_cash_paise", "counted_cash_paise", "variance_paise", "payment_totals", "refund_totals", "ledger_matches_close"];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    const payments = row.payments as Array<{ method: string; amountPaise: string }>;
    const refunds = row.refunds as Array<{ method: string; amountPaise: string }>;
    lines.push([
      row.id, row.cashierName, row.status, row.openedAt, row.closedAt,
      row.openingCashPaise, row.cashCapturedPaise, row.cashRefundedPaise,
      row.expectedCashPaise, row.countedCashPaise, row.variancePaise,
      payments.map((entry) => `${entry.method}:${entry.amountPaise}`).join("; "),
      refunds.map((entry) => `${entry.method}:${entry.amountPaise}`).join("; "),
      row.ledgerMatchesClose,
    ].map(csvCell).join(","));
  }
  return new NextResponse(`\uFEFF${lines.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="kora-shifts-${from}-to-${to}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function GETHandler(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const outletId = params.get("outletId")?.trim() ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required." }, { status: 400 });
  const access = await authorizeAnyOutletPermission(request, outletId, [...requiredPermissions]);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  if (!requiredPermissions.every((permission) => access.permissions.includes(permission))) {
    return NextResponse.json({ error: "Shift reports require financial and staff-performance access." }, { status: 403 });
  }

  const from = params.get("from") ?? indiaDateString();
  const to = params.get("to") ?? from;
  const range = parseIndiaReportRange(from, to);
  if (!range.ok) return NextResponse.json({ error: range.reason === "too-long" ? `Report date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days.` : "Use valid inclusive from/to dates in YYYY-MM-DD format." }, { status: 400 });

  const limitValue = params.get("limit");
  const pageSize = limitValue === null ? DEFAULT_PAGE_SIZE : Number(limitValue);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return NextResponse.json({ error: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.` }, { status: 400 });
  }
  const cursor = params.get("cursor")?.trim() || null;
  const shiftWhere: Prisma.ShiftWhereInput = { tenantId: access.tenantId, outletId, openedAt: { gte: range.startsAt, lt: range.endsAt } };
  try {
    if (cursor) {
      if (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return NextResponse.json({ error: "Invalid shift cursor." }, { status: 400 });
      const cursorShift = await prisma.shift.findFirst({ where: { ...shiftWhere, id: cursor }, select: { id: true } });
      if (!cursorShift) return NextResponse.json({ error: "Invalid shift cursor." }, { status: 400 });
    }
    const page = await prisma.shift.findMany({
      where: shiftWhere,
      orderBy: [{ openedAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, status: true, openedAt: true, closedAt: true, openingCashPaise: true,
        expectedCashPaise: true, countedCashPaise: true, variancePaise: true,
        user: { select: { name: true } },
      },
    });
    const hasMore = page.length > pageSize;
    const shifts = page.slice(0, pageSize);
    const shiftIds = shifts.map((shift) => shift.id);
    const [paymentRows, refundRows] = shiftIds.length ? await Promise.all([
      prisma.payment.groupBy({
        by: ["shiftId", "method"],
        where: { shiftId: { in: shiftIds }, status: PaymentStatus.PAID, bill: { tenantId: access.tenantId, outletId } },
        _sum: { amountPaise: true },
      }),
      prisma.paymentReversal.groupBy({
        by: ["shiftId", "method"],
        where: { tenantId: access.tenantId, outletId, shiftId: { in: shiftIds } },
        _sum: { amountPaise: true },
      }),
    ]) : [[], []];

    const paymentTotals = new Map<string, Map<string, bigint>>();
    for (const entry of paymentRows) {
      if (!entry.shiftId) continue;
      const methods = paymentTotals.get(entry.shiftId) ?? new Map<string, bigint>();
      methods.set(entry.method, entry._sum.amountPaise ?? 0n);
      paymentTotals.set(entry.shiftId, methods);
    }
    const refundTotals = new Map<string, Map<string, bigint>>();
    for (const entry of refundRows) {
      if (!entry.shiftId) continue;
      const methods = refundTotals.get(entry.shiftId) ?? new Map<string, bigint>();
      methods.set(entry.method, entry._sum.amountPaise ?? 0n);
      refundTotals.set(entry.shiftId, methods);
    }

    const rows = shifts.map((shift) => {
      const payments = paymentTotals.get(shift.id) ?? new Map<string, bigint>();
      const refunds = refundTotals.get(shift.id) ?? new Map<string, bigint>();
      const cashCaptured = payments.get("CASH") ?? 0n;
      const cashRefunded = refunds.get("CASH") ?? 0n;
      const ledgerExpected = shift.openingCashPaise + cashCaptured - cashRefunded;
      const expected = shift.expectedCashPaise ?? ledgerExpected;
      return {
        id: shift.id,
        cashierName: shift.user.name,
        status: shift.status,
        openedAt: shift.openedAt.toISOString(),
        closedAt: shift.closedAt?.toISOString() ?? null,
        openingCashPaise: shift.openingCashPaise.toString(),
        cashCapturedPaise: cashCaptured.toString(),
        cashRefundedPaise: cashRefunded.toString(),
        expectedCashPaise: expected.toString(),
        countedCashPaise: shift.countedCashPaise?.toString() ?? null,
        variancePaise: shift.variancePaise?.toString() ?? null,
        ledgerExpectedCashPaise: ledgerExpected.toString(),
        ledgerMatchesClose: shift.expectedCashPaise === null || shift.expectedCashPaise === ledgerExpected,
        payments: [...payments].sort(([left], [right]) => left.localeCompare(right)).map(([method, amount]) => ({ method, amountPaise: amount.toString() })),
        refunds: [...refunds].sort(([left], [right]) => left.localeCompare(right)).map(([method, amount]) => ({ method, amountPaise: amount.toString() })),
      };
    });
    const nextCursor = hasMore ? shifts.at(-1)?.id ?? null : null;
    if (params.get("format") === "csv") return csvResponse(rows, from, to);
    return NextResponse.json({ range: { from, to, timeZone: "Asia/Kolkata", maxDays: MAX_REPORT_RANGE_DAYS }, pageSize, rows: safeJson(rows), nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("KORA shift report failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Shift report could not be loaded." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const GET = withTenantScope(GETHandler);
