import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { gstRateForItem } from "@/lib/domain/gst-profile";

export const runtime = "nodejs";
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required" }, { status: 400 });
  const access = await requirePermission(request, outletId, "menu.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const taxProfile = await prisma.tenant.findFirst({ where: { id: access.tenantId }, select: { gstProfile: true, gstRateBps: true } });
  if (!taxProfile) return NextResponse.json({ error: "Restaurant account not found." }, { status: 404 });
  const categories = await prisma.menuCategory.findMany({ where: { tenantId: access.tenantId, OR: [{ outletId }, { outletId: null }], active: true }, include: { items: { where: { active: true }, include: { variants: { where: { active: true } }, addons: { where: { active: true } }, outletPrices: { where: { outletId } } } } }, orderBy: { sortOrder: "asc" } });
  const withEffectiveTax = categories.map((category) => ({ ...category, items: category.items.map((item) => ({ ...item, gstBps: gstRateForItem(taxProfile.gstProfile, taxProfile.gstRateBps, item.gstBps) })) }));
  return NextResponse.json(jsonSafe(withEffectiveTax));
}

async function POSTHandler(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request); }
  catch (error) { return NextResponse.json({ error: error instanceof RequestInputError ? error.message : "Invalid request body." }, { status: error instanceof RequestInputError ? error.statusCode : 400 }); }
  const outletId = typeof body.outletId === "string" ? body.outletId : "";
  const access = await requirePermission(request, outletId, "menu.edit");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const pricePaise = Number(body.pricePaise);
  const taxRateProvided = Object.hasOwn(body, "gstBps");
  const gstBps = body.gstBps === null || body.gstBps === undefined ? null : Number(body.gstBps);
  if (name.length < 2 || name.length > 120 || !Number.isSafeInteger(pricePaise) || pricePaise < 0) return NextResponse.json({ error: "Provide a dish name and non-negative price in paise." }, { status: 400 });
  if (taxRateProvided && gstBps !== null && (!Number.isSafeInteger(gstBps) || gstBps < 0 || gstBps > 10000)) return NextResponse.json({ error: "Item GST rate must be an integer from 0 to 10000 basis points or inherit the tenant rate." }, { status: 400 });
  const category = await prisma.menuCategory.findFirst({ where: { id: categoryId, tenantId: access.tenantId, OR: [{ outletId }, { outletId: null }] } });
  if (!category) return NextResponse.json({ error: "Category not found in this outlet." }, { status: 404 });
  const pricePermission = await requirePermission(request, outletId, "menu.price_edit");
  if ("error" in pricePermission) return NextResponse.json({ error: "Menu price edit permission required." }, { status: 403 });
  if (taxRateProvided) {
    const taxPermission = await requirePermission(request, outletId, "menu.tax_edit");
    if ("error" in taxPermission) return NextResponse.json({ error: "Menu tax edit permission required." }, { status: 403 });
  }
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.menuItem.create({ data: { tenantId: access.tenantId, categoryId, name, basePricePaise: BigInt(pricePaise), gstBps: taxRateProvided ? gstBps : null, outletPrices: { create: { outletId } } } });
    await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "MENU_ITEM_CREATED", entityType: "MenuItem", entityId: created.id, after: { name, categoryId, pricePaise, gstBps: created.gstBps } } });
    return created;
  });
  void publishOutletEvent(access.tenantId, outletId, "menu:updated", { menuItemId: item.id, action: "created" });
  return NextResponse.json(jsonSafe(item), { status: 201 });
}

async function PATCHHandler(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request); }
  catch (error) { return NextResponse.json({ error: error instanceof RequestInputError ? error.message : "Invalid request body." }, { status: error instanceof RequestInputError ? error.statusCode : 400 }); }
  const outletId = typeof body.outletId === "string" ? body.outletId : "";
  const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId : "";
  const available = typeof body.available === "boolean" ? body.available : undefined;
  const pricePaise = body.pricePaise === undefined ? undefined : Number(body.pricePaise);
  const taxRateProvided = Object.hasOwn(body, "gstBps");
  const gstBps = body.gstBps === null || body.gstBps === undefined ? null : Number(body.gstBps);
  if (!menuItemId || (available === undefined && pricePaise === undefined && !taxRateProvided)) return NextResponse.json({ error: "Provide an item ID and availability, price, or tax rate." }, { status: 400 });
  if (pricePaise !== undefined && (!Number.isSafeInteger(pricePaise) || pricePaise < 0)) return NextResponse.json({ error: "Price must be a non-negative integer number of paise." }, { status: 400 });
  if (taxRateProvided && gstBps !== null && (!Number.isSafeInteger(gstBps) || gstBps < 0 || gstBps > 10000)) return NextResponse.json({ error: "Item GST rate must be an integer from 0 to 10000 basis points or inherit the tenant rate." }, { status: 400 });
  if (available !== undefined) {
    const editAccess = await requirePermission(request, outletId, "menu.edit");
    if ("error" in editAccess) return NextResponse.json({ error: editAccess.error }, { status: editAccess.error === "Unauthenticated" ? 401 : 403 });
  }
  if (pricePaise !== undefined) {
    const priceAccess = await requirePermission(request, outletId, "menu.price_edit");
    if ("error" in priceAccess) return NextResponse.json({ error: priceAccess.error }, { status: priceAccess.error === "Unauthenticated" ? 401 : 403 });
  }
  if (taxRateProvided) {
    const taxAccess = await requirePermission(request, outletId, "menu.tax_edit");
    if ("error" in taxAccess) return NextResponse.json({ error: "Menu tax edit permission required." }, { status: 403 });
  }
  const access = await requirePermission(request, outletId, available !== undefined ? "menu.edit" : pricePaise !== undefined ? "menu.price_edit" : "menu.tax_edit");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const item = await prisma.menuItem.findFirst({ where: { id: menuItemId, tenantId: access.tenantId } });
  if (!item) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
  const previous = await prisma.outletMenuItem.findUnique({ where: { outletId_menuItemId: { outletId, menuItemId } } });
  const saved = await prisma.$transaction(async (tx) => {
    const updated = await tx.outletMenuItem.upsert({ where: { outletId_menuItemId: { outletId, menuItemId } }, update: { ...(available !== undefined ? { available } : {}), ...(pricePaise !== undefined ? { pricePaise: BigInt(pricePaise) } : {}) }, create: { outletId, menuItemId, available: available ?? true, pricePaise: pricePaise === undefined ? null : BigInt(pricePaise) } });
    if (available !== undefined || pricePaise !== undefined) {
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: pricePaise !== undefined ? "MENU_PRICE_CHANGED" : "MENU_AVAILABILITY_CHANGED", entityType: "MenuItem", entityId: menuItemId, ...(previous ? { before: { available: previous.available, pricePaise: previous.pricePaise?.toString() ?? null } } : {}), after: { available: updated.available, pricePaise: updated.pricePaise?.toString() ?? null } } });
    }
    let menuItem = item;
    if (taxRateProvided) {
      menuItem = await tx.menuItem.update({ where: { id: menuItemId }, data: { gstBps } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "MENU_TAX_RATE_CHANGED", entityType: "MenuItem", entityId: menuItemId, before: { gstBps: item.gstBps }, after: { gstBps: menuItem.gstBps } } });
    }
    return { ...updated, gstBps: menuItem.gstBps };
  });
  void publishOutletEvent(access.tenantId, outletId, "menu:updated", { menuItemId, action: "changed" });
  return NextResponse.json(jsonSafe(saved));
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
export const PATCH = withTenantScope(PATCHHandler);
