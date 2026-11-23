import { NextRequest, NextResponse } from "next/server";
import { authorizeOutlet } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

export async function GET(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  if (!outletId) return NextResponse.json({ error: "outletId is required" }, { status: 400 });
  const user = await import("@/lib/server-auth").then(({ getUserFromRequest }) => getUserFromRequest(request));
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const outlet = await prisma.outlet.findFirst({ where: { id: outletId, tenantId: user.tenantId, assignments: { some: { userId: user.id } } } });
  if (!outlet) return NextResponse.json({ error: "Outlet not found or access denied." }, { status: 404 });
  const categories = await prisma.menuCategory.findMany({ where: { tenantId: user.tenantId, OR: [{ outletId }, { outletId: null }], active: true }, include: { items: { where: { active: true }, include: { variants: { where: { active: true } }, addons: { where: { active: true } }, outletPrices: { where: { outletId } } } } }, orderBy: { sortOrder: "asc" } });
  return NextResponse.json(jsonSafe(categories));
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request); }
  catch (error) { return NextResponse.json({ error: error instanceof RequestInputError ? error.message : "Invalid request body." }, { status: 400 }); }
  const outletId = typeof body.outletId === "string" ? body.outletId : "";
  const access = await authorizeOutlet(request, outletId, "menu.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const pricePaise = Number(body.pricePaise);
  if (name.length < 2 || name.length > 120 || !Number.isSafeInteger(pricePaise) || pricePaise < 0) return NextResponse.json({ error: "Provide a dish name and non-negative price in paise." }, { status: 400 });
  const category = await prisma.menuCategory.findFirst({ where: { id: categoryId, tenantId: access.tenantId, OR: [{ outletId }, { outletId: null }] } });
  if (!category) return NextResponse.json({ error: "Category not found in this outlet." }, { status: 404 });
  const item = await prisma.menuItem.create({ data: { tenantId: access.tenantId, categoryId, name, basePricePaise: BigInt(pricePaise), gstBps: 500, outletPrices: { create: { outletId } } } });
  void publishOutletEvent(access.tenantId, outletId, "menu:updated", { menuItemId: item.id, action: "created" });
  return NextResponse.json(jsonSafe(item), { status: 201 });
}

export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await readJsonObject(request); }
  catch (error) { return NextResponse.json({ error: error instanceof RequestInputError ? error.message : "Invalid request body." }, { status: 400 }); }
  const outletId = typeof body.outletId === "string" ? body.outletId : "";
  const access = await authorizeOutlet(request, outletId, "menu.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId : "";
  const available = typeof body.available === "boolean" ? body.available : undefined;
  const pricePaise = body.pricePaise === undefined ? undefined : Number(body.pricePaise);
  if (!menuItemId || (available === undefined && (!Number.isSafeInteger(pricePaise) || pricePaise! < 0))) return NextResponse.json({ error: "Provide an item ID and availability or non-negative price." }, { status: 400 });
  const item = await prisma.menuItem.findFirst({ where: { id: menuItemId, tenantId: access.tenantId } });
  if (!item) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });
  const saved = await prisma.outletMenuItem.upsert({ where: { outletId_menuItemId: { outletId, menuItemId } }, update: { ...(available !== undefined ? { available } : {}), ...(pricePaise !== undefined ? { pricePaise: BigInt(pricePaise) } : {}) }, create: { outletId, menuItemId, available: available ?? true, pricePaise: pricePaise === undefined ? null : BigInt(pricePaise) } });
  void publishOutletEvent(access.tenantId, outletId, "menu:updated", { menuItemId, action: "changed" });
  return NextResponse.json(jsonSafe(saved));
}
