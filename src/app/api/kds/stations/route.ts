import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { publishOutletEvent } from "@/lib/realtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request, 8 * 1024);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "menu.edit");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (name.length < 2 || name.length > 50) return NextResponse.json({ error: "Station names must be 2–50 characters." }, { status: 400 });
    const count = await prisma.station.count({ where: { outletId } });
    if (count >= 30) return NextResponse.json({ error: "An outlet can have up to 30 kitchen stations." }, { status: 409 });
    const station = await prisma.station.create({ data: { outletId, name, sortOrder: count } });
    await prisma.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "KDS_STATION_CREATED", entityType: "Station", entityId: station.id, after: { name } } });
    void publishOutletEvent(access.tenantId, outletId, "kot:updated", { stationId: station.id, action: "station-created" });
    return NextResponse.json(station, { status: 201 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return NextResponse.json({ error: "A station with this name already exists." }, { status: 409 });
    return NextResponse.json({ error: "Could not create kitchen station." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await readJsonObject(request, 8 * 1024);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId : "";
    const stationId = typeof body.stationId === "string" ? body.stationId : "";
    const access = await requirePermission(request, outletId, "menu.edit");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (!menuItemId || !stationId) return NextResponse.json({ error: "menuItemId and stationId are required." }, { status: 400 });
    const [item, station, previous] = await Promise.all([
      prisma.menuItem.findFirst({ where: { id: menuItemId, tenantId: access.tenantId }, select: { id: true, name: true } }),
      prisma.station.findFirst({ where: { id: stationId, outletId, active: true }, select: { id: true, name: true } }),
      prisma.outletMenuItem.findUnique({ where: { outletId_menuItemId: { outletId, menuItemId } }, select: { stationId: true } }),
    ]);
    if (!item || !station) return NextResponse.json({ error: "Menu item or station was not found in this outlet." }, { status: 404 });
    const saved = await prisma.$transaction(async (tx) => {
      const link = await tx.outletMenuItem.upsert({
        where: { outletId_menuItemId: { outletId, menuItemId } },
        update: { stationId },
        create: { outletId, menuItemId, stationId },
      });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "KDS_ITEM_STATION_CHANGED", entityType: "MenuItem", entityId: menuItemId, before: { stationId: previous?.stationId ?? null }, after: { stationId, stationName: station.name, itemName: item.name } } });
      return link;
    });
    void publishOutletEvent(access.tenantId, outletId, "menu:updated", { menuItemId, stationId, action: "station-routing-changed" });
    return NextResponse.json({ menuItemId, stationId: saved.stationId, stationName: station.name });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not route menu item to kitchen station." }, { status: 500 });
  }
}
