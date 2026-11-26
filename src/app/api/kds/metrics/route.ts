import { KOTStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { defaultOutletSettings } from "@/lib/role-seed";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const stationId = request.nextUrl.searchParams.get("stationId");
  if (!outletId) return NextResponse.json({ error: "outletId is required." }, { status: 400 });
  const access = await requirePermission(request, outletId, "reports.view.kds_sla");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const since = new Date(Date.now() - 14 * 24 * 60 * 60_000);
  const [tickets, settingsRow] = await Promise.all([
    prisma.kOT.findMany({
      where: { outletId, order: { tenantId: access.tenantId }, createdAt: { gte: since }, status: { not: KOTStatus.CANCELLED }, ...(stationId && stationId !== "all" ? { stationId } : {}) },
      select: { stationId: true, station: { select: { name: true } }, orderType: true, waiterName: true, createdAt: true, startedAt: true, readyAt: true, servedAt: true, isRush: true, items: { select: { orderItem: { select: { nameSnapshot: true } } } } },
      orderBy: { createdAt: "desc" }, take: 5_000,
    }),
    prisma.outletSettings.findUnique({ where: { outletId }, select: { settings: true } }),
  ]);
  const settings = settingsRow?.settings && typeof settingsRow.settings === "object" && !Array.isArray(settingsRow.settings) ? settingsRow.settings as Record<string, unknown> : {};
  const sla = settings.slaMinutesPerOrderType && typeof settings.slaMinutesPerOrderType === "object" && !Array.isArray(settings.slaMinutesPerOrderType) ? settings.slaMinutesPerOrderType as Record<string, number> : defaultOutletSettings.slaMinutesPerOrderType;
  const stationStats = new Map<string, { stationId: string | null; station: string; tickets: number; prepSeconds: number; prepSamples: number; slaBreaches: number; handoffSeconds: number; handoffSamples: number }>();
  const itemStats = new Map<string, { item: string; tickets: number; prepSeconds: number; samples: number }>();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, tickets: 0 }));
  for (const ticket of tickets) {
    const stationKey = ticket.stationId ?? "general";
    const station = stationStats.get(stationKey) ?? { stationId: ticket.stationId, station: ticket.station?.name ?? "General", tickets: 0, prepSeconds: 0, prepSamples: 0, slaBreaches: 0, handoffSeconds: 0, handoffSamples: 0 };
    station.tickets++;
    const readyAt = ticket.readyAt?.getTime() ?? ticket.servedAt?.getTime();
    if (ticket.startedAt && readyAt) {
      const prep = Math.max(0, Math.floor((readyAt - ticket.startedAt.getTime()) / 1000));
      station.prepSeconds += prep;
      station.prepSamples++;
      if (prep > (Number(sla[ticket.orderType]) || 10) * 60) station.slaBreaches++;
      for (const line of ticket.items) {
        const name = line.orderItem.nameSnapshot;
        const stat = itemStats.get(name) ?? { item: name, tickets: 0, prepSeconds: 0, samples: 0 };
        stat.tickets++;
        stat.prepSeconds += prep;
        stat.samples++;
        itemStats.set(name, stat);
      }
    }
    if (ticket.startedAt) {
      station.handoffSeconds += Math.max(0, Math.floor((ticket.startedAt.getTime() - ticket.createdAt.getTime()) / 1000));
      station.handoffSamples++;
    }
    stationStats.set(stationKey, station);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(ticket.createdAt));
    if (hourly[hour]) hourly[hour].tickets++;
  }
  return NextResponse.json({
    since,
    sampleSize: tickets.length,
    capped: tickets.length === 5_000,
    stations: [...stationStats.values()].map((stat) => ({ ...stat, avgPrepSeconds: stat.prepSamples ? Math.round(stat.prepSeconds / stat.prepSamples) : null, avgHandoffSeconds: stat.handoffSamples ? Math.round(stat.handoffSeconds / stat.handoffSamples) : null })),
    items: [...itemStats.values()].map((stat) => ({ ...stat, avgPrepSeconds: stat.samples ? Math.round(stat.prepSeconds / stat.samples) : null })).sort((a, b) => b.tickets - a.tickets).slice(0, 20),
    hourly,
  });
}

export const GET = withTenantScope(GETHandler);
