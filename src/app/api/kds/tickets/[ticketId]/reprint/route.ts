import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { buildEscPosKot } from "@/lib/domain/escpos-kot";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest, context: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await context.params;
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "kot.reprint");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const ticket = await prisma.kOT.findFirst({
    where: { id: ticketId, outletId, order: { tenantId: access.tenantId } },
    include: { station: { select: { name: true } }, order: { include: { items: true, table: { select: { label: true } } } }, items: { include: { orderItem: true } } },
  });
  if (!ticket) return NextResponse.json({ error: "Kitchen ticket not found." }, { status: 404 });
  await prisma.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "KOT_REPRINTED", entityType: "KOT", entityId: ticket.id, after: { kotNumber: ticket.kotNumber, station: ticket.station?.name ?? null } } });
  const bytes = buildEscPosKot({
    kotNumber: ticket.kotNumber, orderType: ticket.orderType, tableLabel: ticket.tableLabel ?? ticket.order.table?.label,
    waiterName: ticket.waiterName, createdAt: ticket.createdAt, station: ticket.station?.name, notes: ticket.notes,
    items: ticket.items.map((line) => ({ name: line.orderItem.nameSnapshot, quantity: line.quantity, variant: line.orderItem.variantSnapshot, notes: line.orderItem.notes })),
  });
  return new Response(bytes, { headers: { "content-type": "application/vnd.kora.escpos", "content-disposition": `attachment; filename="KOT-${ticket.kotNumber}.bin"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export const GET = withTenantScope(GETHandler);
