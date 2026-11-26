import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { defaultOutletSettings } from "@/lib/role-seed";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "settings.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const row = await prisma.outletSettings.findUnique({ where: { outletId } });
  return NextResponse.json({ settings: row?.settings ?? defaultOutletSettings });
}

async function PATCHHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const access = await requirePermission(request, outletId, "settings.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const current = await prisma.outletSettings.findUnique({ where: { outletId } });
    const before = current?.settings && typeof current.settings === "object" && !Array.isArray(current.settings) ? current.settings as Record<string, unknown> : {};
    const existingThreshold = typeof before.discountApprovalThresholdPct === "number" ? before.discountApprovalThresholdPct : 10;
    const threshold: number = body.discountApprovalThresholdPct === undefined ? existingThreshold : Number(body.discountApprovalThresholdPct);
    const voidRequiresApproval = body.voidRequiresApproval === undefined ? before.voidRequiresApproval ?? false : body.voidRequiresApproval;
    const kdsSoundEnabled = body.kdsSoundEnabled === undefined ? before.kdsSoundEnabled ?? true : body.kdsSoundEnabled;
    const sla = body.slaMinutesPerOrderType === undefined ? before.slaMinutesPerOrderType ?? defaultOutletSettings.slaMinutesPerOrderType : body.slaMinutesPerOrderType;
    const kdsColumnsByStation = body.kdsColumnsByStation === undefined ? before.kdsColumnsByStation ?? defaultOutletSettings.kdsColumnsByStation : body.kdsColumnsByStation;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100 || typeof voidRequiresApproval !== "boolean" || typeof kdsSoundEnabled !== "boolean") return NextResponse.json({ error: "Invalid approval or KDS settings." }, { status: 400 });
    if (!sla || typeof sla !== "object" || Array.isArray(sla) || Object.values(sla as Record<string, unknown>).some((value) => !Number.isInteger(value) || Number(value) < 1 || Number(value) > 240)) return NextResponse.json({ error: "SLA values must be integer minutes from 1 to 240." }, { status: 400 });
    if (!kdsColumnsByStation || typeof kdsColumnsByStation !== "object" || Array.isArray(kdsColumnsByStation)) return NextResponse.json({ error: "KDS columns must be configured by station." }, { status: 400 });
    const activeStations = await prisma.station.findMany({ where: { outletId, active: true }, select: { id: true } });
    const validStationKeys = new Set(["all", ...activeStations.map((station) => station.id)]);
    const validKdsStates = new Set(["QUEUED", "PREPARING", "READY"]);
    for (const [stationKey, value] of Object.entries(kdsColumnsByStation as Record<string, unknown>)) {
      if (!validStationKeys.has(stationKey) || !Array.isArray(value) || value.length < 1 || value.length > 3 || value.some((state) => typeof state !== "string" || !validKdsStates.has(state)) || new Set(value).size !== value.length) {
        return NextResponse.json({ error: "Each station must have 1–3 unique KDS lanes in a valid order." }, { status: 400 });
      }
    }
    const settings = { ...before, discountApprovalThresholdPct: threshold, voidRequiresApproval, kdsSoundEnabled, slaMinutesPerOrderType: sla, kdsColumnsByStation };
    const updated = await prisma.$transaction(async (tx) => {
      const jsonSettings = settings as Prisma.InputJsonValue;
      const saved = await tx.outletSettings.upsert({ where: { outletId }, update: { settings: jsonSettings }, create: { outletId, settings: jsonSettings } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "OUTLET_SETTINGS_CHANGED", entityType: "OutletSettings", entityId: outletId, before: before as Prisma.InputJsonValue, after: jsonSettings } });
      return saved;
    });
    return NextResponse.json({ settings: updated.settings });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not update outlet settings." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const PATCH = withTenantScope(PATCHHandler);
