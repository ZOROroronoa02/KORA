import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { gstProfileDefaults, gstinStateMatchesAddress, hasInvoiceAddress, isValidGstin, validateGstConfiguration, type GstProfile } from "@/lib/domain/gst-profile";

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
    select: { id: true, name: true, fssaiLicense: true, address: true, tenant: { select: { name: true, gstin: true, gstProfile: true, gstRateBps: true } } },
  });
  if (!outlet) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
  return NextResponse.json({ profile: {
    outletName: outlet.name,
    businessName: outlet.tenant.name,
    gstin: outlet.tenant.gstin ?? "",
    gstProfile: outlet.tenant.gstProfile,
    gstRateBps: outlet.tenant.gstRateBps,
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
    const gstinInput = text(body.gstin, 15);
    const fssaiLicense = text(body.fssaiLicense, 14);
    const address = readAddress(body.address);
    const profileInput = body.gstProfile === undefined ? undefined : body.gstProfile;
    const gstProfileNames = Object.keys(gstProfileDefaults) as GstProfile[];
    if (profileInput !== undefined && (typeof profileInput !== "string" || !gstProfileNames.includes(profileInput as GstProfile))) return NextResponse.json({ error: "Select a supported GST profile." }, { status: 400 });
    if (!outletName || outletName.length < 2) return NextResponse.json({ error: "Outlet name must contain 2–100 characters." }, { status: 400 });
    if (gstinInput === null) return NextResponse.json({ error: "GSTIN must contain 15 characters or be blank." }, { status: 400 });
    if (fssaiLicense === null || (fssaiLicense !== "" && !/^\d{14}$/.test(fssaiLicense))) return NextResponse.json({ error: "FSSAI license must contain 14 digits or be blank." }, { status: 400 });
    if (!address) return NextResponse.json({ error: "Address fields are invalid. PIN code must contain 6 digits." }, { status: 400 });

    const current = await prisma.outlet.findUnique({ where: { id: outletId }, select: { id: true, name: true, fssaiLicense: true, address: true, tenant: { select: { id: true, name: true, gstin: true, gstProfile: true, gstRateBps: true } } } });
    if (!current) return NextResponse.json({ error: "Outlet not found." }, { status: 404 });
    const gstin = gstinInput.toUpperCase();
    const gstProfile = (profileInput as GstProfile | undefined) ?? current.tenant.gstProfile;
    const gstRateBps = body.gstRateBps === undefined
      ? (profileInput && profileInput !== current.tenant.gstProfile ? gstProfileDefaults[gstProfile].rateBps : current.tenant.gstRateBps)
      : Number(body.gstRateBps);
    if (body.gstRateBps !== undefined && !Number.isSafeInteger(gstRateBps)) return NextResponse.json({ error: "GST rate must be a whole number of basis points." }, { status: 400 });
    const configurationError = validateGstConfiguration({ profile: gstProfile, rateBps: gstRateBps, gstin });
    if (configurationError) return NextResponse.json({ error: configurationError }, { status: 400 });
    const taxChanged = gstin !== (current.tenant.gstin ?? "") || gstProfile !== current.tenant.gstProfile || gstRateBps !== current.tenant.gstRateBps;
    if (taxChanged && !access.permissions.includes("tax.profile.manage")) return NextResponse.json({ error: "GST profile management permission required." }, { status: 403 });
    if (gstProfile !== "NOT_REGISTERED" && hasInvoiceAddress(address) && !gstinStateMatchesAddress(gstin, address.state)) return NextResponse.json({ error: "Outlet state must match the GSTIN registration state." }, { status: 400 });
    const next = { outletName, fssaiLicense, address };
    const before = { outletName: current.name, fssaiLicense: current.fssaiLicense ?? "", address: formatAddress(current.address) };
    const updated = await prisma.$transaction(async (tx) => {
      if (taxChanged) {
        await tx.tenant.update({ where: { id: access.tenantId }, data: { gstin: gstin || null, gstProfile, gstRateBps } });
        await tx.auditLog.create({ data: {
          tenantId: access.tenantId, outletId, userId: access.user.id, action: "TENANT_GST_PROFILE_CHANGED", entityType: "Tenant", entityId: access.tenantId,
          before: { gstin: current.tenant.gstin ?? "", gstProfile: current.tenant.gstProfile, gstRateBps: current.tenant.gstRateBps },
          after: { gstin, gstProfile, gstRateBps },
        } });
      }
      const saved = await tx.outlet.update({
        where: { id: outletId },
        data: { name: outletName, fssaiLicense: fssaiLicense || null, address: address as Prisma.InputJsonValue },
        select: { id: true, name: true, fssaiLicense: true, address: true, tenant: { select: { name: true, gstin: true, gstProfile: true, gstRateBps: true } } },
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return NextResponse.json({ profile: {
      outletName: updated.name,
      businessName: updated.tenant.name,
      gstin: updated.tenant.gstin ?? "",
      gstProfile: updated.tenant.gstProfile,
      gstRateBps: updated.tenant.gstRateBps,
      fssaiLicense: updated.fssaiLicense ?? "",
      address: formatAddress(updated.address),
    } });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ error: "That GSTIN is already assigned to another tenant." }, { status: 409 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return NextResponse.json({ error: "GST profile changed concurrently. Refresh and try again." }, { status: 409 });
    return NextResponse.json({ error: "Could not save outlet profile." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const PATCH = withTenantScope(PATCHHandler);
