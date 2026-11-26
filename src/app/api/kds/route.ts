import { KOTStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { defaultOutletSettings } from "@/lib/role-seed";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required." }, { status: 400 });
  const access = await requirePermission(request, outletId, "kds.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

  const stationId = request.nextUrl.searchParams.get("stationId");
  const includeServed = request.nextUrl.searchParams.get("includeServed") === "1";
  const status = includeServed
    ? { in: [KOTStatus.QUEUED, KOTStatus.PREPARING, KOTStatus.READY, KOTStatus.SERVED] }
    : { in: [KOTStatus.QUEUED, KOTStatus.PREPARING, KOTStatus.READY] };
  const [outlet, stations, tickets, settingsRow] = await Promise.all([
    prisma.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId }, select: { id: true, name: true } }),
    prisma.station.findMany({ where: { outletId, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, sortOrder: true } }),
    prisma.kOT.findMany({
      where: {
        outletId,
        order: { tenantId: access.tenantId },
        status,
        ...(stationId && stationId !== "all" ? { stationId } : {}),
        ...(includeServed ? { OR: [{ status: { not: KOTStatus.SERVED } }, { servedAt: { gte: new Date(Date.now() - 30 * 60_000) } }] } : {}),
      },
      include: {
        station: { select: { id: true, name: true } },
        order: { include: { table: { select: { label: true } }, createdBy: { select: { name: true } } } },
        items: { include: { orderItem: { select: { menuItemId: true, nameSnapshot: true, variantSnapshot: true, addonsSnapshot: true, notes: true } } } },
      },
      orderBy: [{ createdAt: "asc" }, { kotNumber: "asc" }],
      take: includeServed ? 150 : 300,
    }),
    prisma.outletSettings.findUnique({ where: { outletId }, select: { settings: true } }),
  ]);
  if (!outlet) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
  const settings = settingsRow?.settings && typeof settingsRow.settings === "object" && !Array.isArray(settingsRow.settings)
    ? settingsRow.settings as Record<string, unknown>
    : {};
  const sla = settings.slaMinutesPerOrderType && typeof settings.slaMinutesPerOrderType === "object" && !Array.isArray(settings.slaMinutesPerOrderType)
    ? settings.slaMinutesPerOrderType
    : defaultOutletSettings.slaMinutesPerOrderType;
  const ticketsWithNames = tickets.map((ticket) => ({
    id: ticket.id,
    kotNumber: ticket.kotNumber,
    orderId: ticket.orderId,
    orderNumber: ticket.order.orderNumber,
    orderType: ticket.orderType,
    tableLabel: ticket.tableLabel ?? ticket.order.table?.label ?? null,
    waiterName: ticket.waiterName ?? ticket.order.createdBy?.name ?? "Staff",
    station: ticket.station,
    status: ticket.status,
    notes: ticket.notes,
    isRush: ticket.isRush,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    startedAt: ticket.startedAt,
    readyAt: ticket.readyAt,
    servedAt: ticket.servedAt,
    heldAt: ticket.heldAt,
    holdReason: ticket.holdReason,
    holdDurationSeconds: ticket.holdDurationSeconds,
    undoBumpUntil: ticket.undoBumpUntil,
    items: ticket.items.map((item) => ({
      id: item.id,
      menuItemId: item.orderItem.menuItemId,
      name: item.orderItem.nameSnapshot,
      quantity: item.quantity,
      variant: item.orderItem.variantSnapshot,
      modifiers: item.orderItem.addonsSnapshot,
      notes: item.orderItem.notes,
      state: item.state,
      updatedAt: item.updatedAt,
    })),
  }));
  return NextResponse.json(safeJson({
    outlet,
    stations,
    tickets: ticketsWithNames,
    settings: {
      slaMinutesPerOrderType: sla,
      kdsSoundEnabled: settings.kdsSoundEnabled !== false,
      kdsColumnsByStation: settings.kdsColumnsByStation ?? {},
    },
    serverTimestamp: new Date().toISOString(),
  }));
}

export const GET = withTenantScope(GETHandler);
