import { OrderStatus, PaymentStatus, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAnyOutletPermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { indiaDateString, MAX_REPORT_RANGE_DAYS, parseIndiaReportRange } from "@/lib/domain/report-dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reportPermissions = ["reports.view.sales", "reports.view.financial", "reports.view.gst"];

type SalesReportPayload = {
  summary: { billCount: number };
  financials?: Record<string, string>;
  daily: Array<{ date: string; billCount: number; totalPaise?: string }>;
  topItems: Array<{ name: string; quantity: string; salesPaise?: string }>;
  paymentActivity?: Array<{ method: string; amountPaise: string }>;
  refundActivity?: Array<{ method: string; amountPaise: string }>;
  gstSummary?: Array<{ documentType: string; gstProfile: string; taxablePaise: string; cgstPaise: string; sgstPaise: string; igstPaise: string }>;
};

function toCsvText(value: unknown) {
  let text = String(value ?? "");
  if (/^[\t\r ]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvResponse(report: SalesReportPayload, from: string, to: string) {
  const rows: string[][] = [["section", "label", "count", "amount_paise", "details"]];
  rows.push(["sales", "bills_issued", String(report.summary.billCount), "", ""].map(toCsvText));
  if (report.financials) {
    for (const [label, amount] of Object.entries(report.financials)) rows.push(["sales", label, "", String(amount), ""].map(toCsvText));
    for (const item of report.topItems) rows.push(["items", item.name, String(item.quantity), item.salesPaise ?? "", "before GST and service charge"].map(toCsvText));
    for (const entry of report.paymentActivity ?? []) rows.push(["payment_activity", entry.method, "", entry.amountPaise, "recorded during selected dates"].map(toCsvText));
    for (const entry of report.refundActivity ?? []) rows.push(["refund_activity", entry.method, "", entry.amountPaise, "recorded during selected dates"].map(toCsvText));
  } else {
    for (const item of report.topItems) rows.push(["items", item.name, String(item.quantity), "", ""].map(toCsvText));
  }
  for (const entry of report.daily) rows.push(["daily_sales", entry.date, String(entry.billCount), entry.totalPaise ?? "", "bill issue date"].map(toCsvText));
  for (const entry of report.gstSummary ?? []) rows.push(["gst_summary", entry.documentType, "", entry.taxablePaise, `${entry.gstProfile}; CGST ${entry.cgstPaise}; SGST ${entry.sgstPaise}; IGST ${entry.igstPaise}`].map(toCsvText));
  const content = rows.map((row) => row.join(",")).join("\r\n");
  return new NextResponse(`\uFEFF${content}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="kora-sales-${from}-to-${to}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required." }, { status: 400 });
  const access = await authorizeAnyOutletPermission(request, outletId, reportPermissions);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

  const from = request.nextUrl.searchParams.get("from") ?? indiaDateString();
  const to = request.nextUrl.searchParams.get("to") ?? from;
  const range = parseIndiaReportRange(from, to);
  if (!range.ok) return NextResponse.json({ error: range.reason === "too-long" ? `Report date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days.` : "Use valid inclusive from/to dates in YYYY-MM-DD format." }, { status: 400 });
  const { startsAt, endsAt } = range;

  const canViewSales = access.permissions.includes("reports.view.sales");
  const canViewFinancials = access.permissions.includes("reports.view.financial");
  const canViewGst = access.permissions.includes("reports.view.gst");
  const billWhere: Prisma.BillWhereInput = {
    tenantId: access.tenantId,
    outletId,
    issuedAt: { gte: startsAt, lt: endsAt },
    order: { tenantId: access.tenantId, outletId, status: { not: OrderStatus.CANCELLED } },
  };

  const aggregate = await prisma.bill.aggregate({
    where: billWhere,
    _count: { _all: true },
    _sum: { subtotalPaise: true, discountPaise: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, serviceChargePaise: true, totalPaise: true },
  });
  const [dailyRows, itemRows, paymentRows, refundRows, gstRows] = await Promise.all([
    canViewSales ? prisma.$queryRaw<Array<{ date: string; billCount: number; totalPaise: bigint }>>`
      SELECT to_char(date_trunc('day', b."issuedAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS "date",
        COUNT(*)::integer AS "billCount", SUM(b."totalPaise") AS "totalPaise"
      FROM "bills" b JOIN "orders" o ON o."id" = b."orderId" AND o."tenantId" = b."tenantId" AND o."outletId" = b."outletId"
      WHERE b."tenantId" = ${access.tenantId} AND b."outletId" = ${outletId}
        AND b."issuedAt" >= ${startsAt} AND b."issuedAt" < ${endsAt} AND o."status" <> 'CANCELLED'
      GROUP BY 1 ORDER BY 1
    ` : Promise.resolve([]),
    canViewSales ? prisma.$queryRaw<Array<{ name: string; quantity: bigint; salesPaise: bigint }>>`
      SELECT i."nameSnapshot" AS "name", SUM(i."quantity") AS "quantity", SUM(i."totalPaise") AS "salesPaise"
      FROM "order_items" i
      JOIN "orders" o ON o."id" = i."orderId"
      JOIN "bills" b ON b."orderId" = o."id" AND b."tenantId" = o."tenantId" AND b."outletId" = o."outletId"
      WHERE o."tenantId" = ${access.tenantId} AND o."outletId" = ${outletId}
        AND b."issuedAt" >= ${startsAt} AND b."issuedAt" < ${endsAt} AND o."status" <> 'CANCELLED'
      GROUP BY i."nameSnapshot" ORDER BY SUM(i."quantity") DESC, SUM(i."totalPaise") DESC, i."nameSnapshot" ASC
      LIMIT 10
    ` : Promise.resolve([]),
    canViewFinancials ? prisma.payment.groupBy({
      by: ["method"],
      where: { status: PaymentStatus.PAID, recordedAt: { gte: startsAt, lt: endsAt }, bill: { tenantId: access.tenantId, outletId } },
      _sum: { amountPaise: true },
    }) : Promise.resolve([]),
    canViewFinancials ? prisma.paymentReversal.groupBy({
      by: ["method"], where: { tenantId: access.tenantId, outletId, recordedAt: { gte: startsAt, lt: endsAt } }, _sum: { amountPaise: true },
    }) : Promise.resolve([]),
    canViewGst ? prisma.bill.groupBy({ by: ["documentType", "gstProfile"], where: billWhere, _sum: { taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true } }) : Promise.resolve([]),
  ]);

  const sum = aggregate._sum;
  const report = {
    range: { from, to, timeZone: "Asia/Kolkata", maxDays: MAX_REPORT_RANGE_DAYS },
    summary: { billCount: aggregate._count._all },
    ...(canViewFinancials ? { financials: {
      subtotalPaise: (sum.subtotalPaise ?? 0n).toString(), discountPaise: (sum.discountPaise ?? 0n).toString(),
      taxablePaise: (sum.taxablePaise ?? 0n).toString(), cgstPaise: (sum.cgstPaise ?? 0n).toString(),
      sgstPaise: (sum.sgstPaise ?? 0n).toString(), igstPaise: (sum.igstPaise ?? 0n).toString(),
      serviceChargePaise: (sum.serviceChargePaise ?? 0n).toString(), billedTotalPaise: (sum.totalPaise ?? 0n).toString(),
    } } : {}),
    daily: dailyRows.map((row) => ({ date: row.date, billCount: row.billCount, ...(canViewFinancials ? { totalPaise: row.totalPaise.toString() } : {}) })),
    topItems: itemRows.map((row) => ({ name: row.name, quantity: row.quantity.toString(), ...(canViewFinancials ? { salesPaise: row.salesPaise.toString() } : {}) })),
    ...(canViewFinancials ? {
      paymentActivity: [...paymentRows].sort((left, right) => left.method.localeCompare(right.method)).map((row) => ({ method: row.method, amountPaise: (row._sum.amountPaise ?? 0n).toString() })),
      refundActivity: [...refundRows].sort((left, right) => left.method.localeCompare(right.method)).map((row) => ({ method: row.method, amountPaise: (row._sum.amountPaise ?? 0n).toString() })),
    } : {}),
    ...(canViewGst ? { gstSummary: [...gstRows].sort((left, right) => `${left.documentType}-${left.gstProfile}`.localeCompare(`${right.documentType}-${right.gstProfile}`)).map((row) => ({
      documentType: row.documentType, gstProfile: row.gstProfile,
      taxablePaise: (row._sum.taxablePaise ?? 0n).toString(), cgstPaise: (row._sum.cgstPaise ?? 0n).toString(),
      sgstPaise: (row._sum.sgstPaise ?? 0n).toString(), igstPaise: (row._sum.igstPaise ?? 0n).toString(),
    })) } : {}),
  };

  if (request.nextUrl.searchParams.get("format") === "csv") return csvResponse(report, from, to);
  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}

export const GET = withTenantScope(GETHandler);
