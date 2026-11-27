import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requirePermission, withTenantScope } from "@/lib/server-auth";

export const runtime = "nodejs";
const PAGE_SIZE = 100;

type VendorInput = { name: string; phone: string | null; email: string | null; gstin: string | null };

function vendorInput(body: Record<string, unknown>): VendorInput | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phoneInput = typeof body.phone === "string" ? body.phone.trim() : "";
  const phone = phoneInput.replace(/[\s()-]/g, "");
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const gstin = typeof body.gstin === "string" ? body.gstin.trim().toUpperCase() : "";
  if (name.length < 2 || name.length > 100) return null;
  if (phone && (phone.length > 20 || !/^\+?[0-9]{8,15}$/.test(phone))) return null;
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null;
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return null;
  return { name, phone: phone || null, email: email || null, gstin: gstin || null };
}

function authError(error: "Unauthenticated" | "Forbidden") {
  return NextResponse.json({ error }, { status: error === "Unauthenticated" ? 401 : 403 });
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  const access = await requirePermission(request, outletId, "inventory.view");
  if ("error" in access) return authError(access.error);
  const parsedLimit = Number(request.nextUrl.searchParams.get("limit") ?? PAGE_SIZE);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, PAGE_SIZE) : PAGE_SIZE;
  const cursor = request.nextUrl.searchParams.get("cursor")?.trim() ?? "";
  if (cursor.length > 100) return NextResponse.json({ error: "Invalid vendor cursor." }, { status: 400 });
  if (cursor && !(await prisma.vendor.findFirst({ where: { id: cursor, tenantId: access.tenantId }, select: { id: true } }))) return NextResponse.json({ error: "Invalid vendor cursor." }, { status: 400 });
  const rows = await prisma.vendor.findMany({
    where: { tenantId: access.tenantId },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true, name: true, phone: true, email: true, gstin: true, active: true },
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return NextResponse.json({ items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null });
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const access = await requirePermission(request, outletId, "inventory.adjust");
    if ("error" in access) return authError(access.error);
    const input = vendorInput(body);
    if (!input) return NextResponse.json({ error: "Enter a vendor name, valid phone/email, and a valid GSTIN when provided." }, { status: 400 });
    const vendor = await prisma.$transaction(async (tx) => {
      const created = await tx.vendor.create({ data: { tenantId: access.tenantId, ...input } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "VENDOR_CREATED", entityType: "Vendor", entityId: created.id, after: input } });
      return created;
    });
    return NextResponse.json({ vendor }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    return NextResponse.json({ error: "Could not create vendor." }, { status: 500 });
  }
}

async function PATCHHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const access = await requirePermission(request, outletId, "inventory.adjust");
    if ("error" in access) return authError(access.error);
    const vendorId = typeof body.vendorId === "string" ? body.vendorId.trim() : "";
    if (!vendorId || vendorId.length > 100) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
    const before = await prisma.vendor.findFirst({ where: { id: vendorId, tenantId: access.tenantId } });
    if (!before) return NextResponse.json({ error: "Vendor not found in this tenant." }, { status: 404 });

    const update: Partial<VendorInput> & { active?: boolean } = {};
    if ("name" in body || "phone" in body || "email" in body || "gstin" in body) {
      const merged = vendorInput({ name: body.name ?? before.name, phone: body.phone ?? before.phone ?? "", email: body.email ?? before.email ?? "", gstin: body.gstin ?? before.gstin ?? "" });
      if (!merged) return NextResponse.json({ error: "Enter a vendor name, valid phone/email, and a valid GSTIN when provided." }, { status: 400 });
      Object.assign(update, merged);
    }
    if ("active" in body) {
      if (typeof body.active !== "boolean") return NextResponse.json({ error: "Vendor active status must be true or false." }, { status: 400 });
      update.active = body.active;
    }
    if (Object.keys(update).length === 0) return NextResponse.json({ error: "Provide at least one vendor field to update." }, { status: 400 });

    const saved = await prisma.$transaction(async (tx) => {
      const result = await tx.vendor.updateMany({
        where: { id: vendorId, tenantId: access.tenantId, name: before.name, phone: before.phone, email: before.email, gstin: before.gstin, active: before.active },
        data: update,
      });
      if (result.count !== 1) return null;
      const current = await tx.vendor.findFirstOrThrow({ where: { id: vendorId, tenantId: access.tenantId } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "VENDOR_UPDATED", entityType: "Vendor", entityId: vendorId, before: { name: before.name, phone: before.phone, email: before.email, gstin: before.gstin, active: before.active }, after: { name: current.name, phone: current.phone, email: current.email, gstin: current.gstin, active: current.active } } });
      return current;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (!saved) return NextResponse.json({ error: "Vendor changed concurrently. Refresh and try again." }, { status: 409 });
    return NextResponse.json({ vendor: saved });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return NextResponse.json({ error: "Vendor changed concurrently. Refresh and try again." }, { status: 409 });
    return NextResponse.json({ error: "Could not update vendor." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
export const PATCH = withTenantScope(PATCHHandler);
