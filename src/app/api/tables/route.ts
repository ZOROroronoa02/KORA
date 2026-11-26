import { NextRequest, NextResponse } from "next/server";
import { authorizeAnyOutletPermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await authorizeAnyOutletPermission(request, outletId, ["orders.create", "orders.read"]);
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const [tables, outlet] = await Promise.all([prisma.restaurantTable.findMany({
    where: { outletId, active: true }, orderBy: { label: "asc" },
    select: { id: true, label: true, section: true, capacity: true, orders: { where: { status: { in: ["OPEN", "SENT", "PREPARING", "READY", "SERVED"] } }, select: { id: true }, take: 1 } },
  }), prisma.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId }, select: { serviceChargeBps: true } })]);
  return NextResponse.json({ tables: tables.map(({ orders, ...table }) => ({ ...table, occupied: orders.length > 0 })), serviceChargeBps: outlet?.serviceChargeBps ?? 0 });
}
