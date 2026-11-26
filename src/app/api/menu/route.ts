import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required" }, { status: 400 });
  const access = await requirePermission(request, outletId, "menu.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const categories = await prisma.menuCategory.findMany({ where: { tenantId: access.tenantId, OR: [{ outletId }, { outletId: null }], active: true }, include: { items: { where: { active: true }, include: { variants: { where: { active: true } }, addons: { where: { active: true } }, outletPrices: { where: { outletId } } } } }, orderBy: { sortOrder: "asc" } });
  return NextResponse.json(jsonSafe(categories));
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
  if (name.length < 2 || name.length > 120 || !Number.isSafeInteger(pricePaise) || pricePaise < 0) return NextResponse.json({ error: "Provide a dish name and non-negative price in paise." }, { status: 400 });
  const category = await prisma.menuCategory.findFirst({ where: { id: categoryId, tenantId: access.tenantId, OR: [{ outletId }, { outletId: null }] } });
  if (!category) return NextResponse.json({ error: "Category not found in this outlet." }, { status: 404 });
  const pricePermission = await requirePermission(request, outletId, "menu.price_edit");
  if ("error" in pricePermission) return NextResponse.json({ error: "Menu price edit permission required." }, { status: 403 });
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.menuItem.create({ data: { tenantId: access.tenantId, categoryId, name, basePricePaise: BigInt(pricePaise), gstBps: 500, outletPrices: { create: { outletId } } } });
    await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "MENU_ITEM_CREATED", entityType: "MenuItem", entityId: created.id, after: { name, categoryId, pricePaise } } });
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
  if (!menuItemId || (available === undefined && (!Number.isSafeInteger(pricePaise) || pricePaise! < 0))) return NextResponse.json({ error: "Provide an item ID and availability or non-negative price." }, { status: 400 });
  if (available !== undefined) {
    const editAccess = await requirePermission(request, outletId, "menu.edit");
    if ("error" in editAccess) return NextResponse.json({ error: editAccess.error }, { status: editAccess.error === "Unauthenticated" ? 401 : 403 });
  }
  if (pricePaise !== undefined) {
    const priceAccess = await requirePermission(request, outletId, "menu.price_edit");
    if ("error" in priceAccess) return NextResponse.json({ error: priceAccess.error }, { status: priceAccess.error === "Unauthenticated" ? 401 : 403 });
  }
  const access = await requirePermission(request, outletId, available !== undefined ? "menu.edit" : "menu.price_edit");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const item = await prisma.menuItem.findFirst({ where: { id: menuItemId, tenantId: access.tenantId } });
  if (!item) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
  const previous = await prisma.outletMenuItem.findUnique({ where: { outletId_menuItemId: { outletId, menuItemId } } });
  const saved = await prisma.$transaction(async (tx) => {
    const updated = await tx.outletMenuItem.upsert({ where: { outletId_menuItemId: { outletId, menuItemId } }, update: { ...(available !== undefined ? { available } : {}), ...(pricePaise !== undefined ? { pricePaise: BigInt(pricePaise) } : {}) }, create: { outletId, menuItemId, available: available ?? true, pricePaise: pricePaise === undefined ? null : BigInt(pricePaise) } });
    await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: pricePaise !== undefined ? "MENU_PRICE_CHANGED" : "MENU_AVAILABILITY_CHANGED", entityType: "MenuItem", entityId: menuItemId, ...(previous ? { before: { available: previous.available, pricePaise: previous.pricePaise?.toString() ?? null } } : {}), after: { available: updated.available, pricePaise: updated.pricePaise?.toString() ?? null } } });
    return updated;
  });
  void publishOutletEvent(access.tenantId, outletId, "menu:updated", { menuItemId, action: "changed" });
  return NextResponse.json(jsonSafe(saved));
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
export const PATCH = withTenantScope(PATCHHandler);
