import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requirePermission, withTenantScope } from "@/lib/server-auth";

export const runtime = "nodejs";

type OutletAddress = { line1: string; line2: string; city: string; state: string; pincode: string };

function text(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maximumLength ? normalized : null;
}

function readAddress(value: unknown): OutletAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const line1 = text(source.line1 ?? "", 120);
  const line2 = text(source.line2 ?? "", 120);
  const city = text(source.city ?? "", 80);
  const state = text(source.state ?? "", 80);
  const pincode = text(source.pincode ?? "", 6);
  if ([line1, line2, city, state, pincode].some((entry) => entry === null)) return null;
  if (pincode && !/^\d{6}$/.test(pincode)) return null;
  return { line1: line1!, line2: line2!, city: city!, state: state!, pincode: pincode! };
}

function formatAddress(value: Prisma.JsonValue | null): OutletAddress {
  const address = readAddress(value);
  return address ?? { line1: "", line2: "", city: "", state: "", pincode: "" };
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  const access = await requirePermission(request, outletId, "settings.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

  const outlet = await prisma.outlet.findUnique({
    where: { id: outletId },
    select: { id: true, name: true, gstin: true, fssaiLicense: true, address: true, tenant: { select: { name: true } } },
  });
  if (!outlet) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
  return NextResponse.json({ profile: {
    outletName: outlet.name,
    businessName: outlet.tenant.name,
    gstin: outlet.gstin ?? "",
    fssaiLicense: outlet.fssaiLicense ?? "",
    address: formatAddress(outlet.address),
  } });
}

async function PATCHHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const access = await requirePermission(request, outletId, "settings.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });

    const outletName = text(body.outletName, 100);
    const gstin = text(body.gstin, 15);
    const fssaiLicense = text(body.fssaiLicense, 14);
    const address = readAddress(body.address);
    if (!outletName || outletName.length < 2) return NextResponse.json({ error: "Outlet name must contain 2–100 characters." }, { status: 400 });
    if (gstin === null || (gstin !== "" && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin))) return NextResponse.json({ error: "Enter a valid 15-character GSTIN or leave it blank." }, { status: 400 });
    if (fssaiLicense === null || (fssaiLicense !== "" && !/^\d{14}$/.test(fssaiLicense))) return NextResponse.json({ error: "FSSAI license must contain 14 digits or be blank." }, { status: 400 });
    if (!address) return NextResponse.json({ error: "Address fields are invalid. PIN code must contain 6 digits." }, { status: 400 });

    const current = await prisma.outlet.findUnique({ where: { id: outletId }, select: { id: true, name: true, gstin: true, fssaiLicense: true, address: true } });
    if (!current) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
    const next = { outletName, gstin, fssaiLicense, address };
    const before = { outletName: current.name, gstin: current.gstin ?? "", fssaiLicense: current.fssaiLicense ?? "", address: formatAddress(current.address) };
    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.outlet.update({
        where: { id: outletId },
        data: { name: outletName, gstin: gstin || null, fssaiLicense: fssaiLicense || null, address: address as Prisma.InputJsonValue },
        select: { id: true, name: true, gstin: true, fssaiLicense: true, address: true, tenant: { select: { name: true } } },
      });
      await tx.auditLog.create({ data: {
        tenantId: access.tenantId,
        outletId,
        userId: access.user.id,
        action: "OUTLET_PROFILE_CHANGED",
        entityType: "Outlet",
        entityId: outletId,
        before: before as Prisma.InputJsonValue,
        after: next as Prisma.InputJsonValue,
      } });
      return saved;
    });

    return NextResponse.json({ profile: {
      outletName: updated.name,
      businessName: updated.tenant.name,
      gstin: updated.gstin ?? "",
      fssaiLicense: updated.fssaiLicense ?? "",
      address: formatAddress(updated.address),
    } });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not save outlet profile." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const PATCH = withTenantScope(PATCHHandler);
