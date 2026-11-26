import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

async function GETHandler(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const outletId = params.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "audit.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const userId = params.get("userId");
  const action = params.get("action");
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) return NextResponse.json({ error: "Provide a valid date range." }, { status: 400 });
  const entries = await prisma.auditLog.findMany({
    where: { tenantId: access.tenantId, outletId, ...(userId ? { userId } : {}), ...(action ? { action } : {}), ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
    include: { user: { select: { id: true, name: true, email: true } }, approvalUser: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }, take: 100,
  });
  return NextResponse.json({ entries });
}

export const GET = withTenantScope(GETHandler);
