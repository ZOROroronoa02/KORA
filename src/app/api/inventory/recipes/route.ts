import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const MAX_STOCK_QUANTITY = 9_223_372_036_854_775_807n;
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));

class RecipeNotFoundError extends Error {}
class RecipeAlreadyExistsError extends Error {}

function quantityInput(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,19}$/.test(value)) {
    const quantity = BigInt(value);
    return quantity > 0n && quantity <= MAX_STOCK_QUANTITY ? quantity : null;
  }
  return null;
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  const access = await requirePermission(request, outletId, "inventory.view");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const requestedTake = Number(request.nextUrl.searchParams.get("take") ?? 100);
  const take = Number.isInteger(requestedTake) ? Math.max(1, Math.min(requestedTake, 200)) : 100;
  const cursor = request.nextUrl.searchParams.get("cursor")?.trim();
  const requestedMenuTake = Number(request.nextUrl.searchParams.get("menuTake") ?? 100);
  const menuTake = Number.isInteger(requestedMenuTake) ? Math.max(1, Math.min(requestedMenuTake, 200)) : 100;
  const menuCursor = request.nextUrl.searchParams.get("menuCursor")?.trim();
  if (cursor && cursor.length > 80) return NextResponse.json({ error: "Recipe cursor is invalid." }, { status: 400 });
  if (menuCursor && menuCursor.length > 80) return NextResponse.json({ error: "Menu item cursor is invalid." }, { status: 400 });
  if (cursor) {
    const ownedCursor = await prisma.recipe.findFirst({ where: { id: cursor, tenantId: access.tenantId, outletId }, select: { id: true } });
    if (!ownedCursor) return NextResponse.json({ error: "Recipe cursor is invalid." }, { status: 400 });
  }
  if (menuCursor) {
    const ownedCursor = await prisma.menuItem.findFirst({ where: { id: menuCursor, tenantId: access.tenantId, active: true, outletPrices: { some: { outletId } } }, select: { id: true } });
    if (!ownedCursor) return NextResponse.json({ error: "Menu item cursor is invalid." }, { status: 400 });
  }
  const [recipes, menuItems] = await Promise.all([
    prisma.recipe.findMany({
      where: { tenantId: access.tenantId, outletId },
      orderBy: { id: "asc" }, take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { menuItem: { select: { id: true, name: true } }, ingredients: { orderBy: { rawMaterial: { name: "asc" } }, include: { rawMaterial: { select: { id: true, name: true, unit: true, quantityMilli: true } } } } },
    }),
    prisma.menuItem.findMany({
      where: { tenantId: access.tenantId, active: true, outletPrices: { some: { outletId } } },
      select: { id: true, name: true }, orderBy: { id: "asc" }, take: menuTake + 1,
      ...(menuCursor ? { cursor: { id: menuCursor }, skip: 1 } : {}),
    }),
  ]);
  const hasMore = recipes.length > take;
  const page = recipes.slice(0, take);
  const hasMoreMenuItems = menuItems.length > menuTake;
  const menuPage = menuItems.slice(0, menuTake);
  return NextResponse.json(safeJson({
    recipes: page,
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    menuItems: menuPage,
    nextMenuCursor: hasMoreMenuItems ? menuPage.at(-1)?.id ?? null : null,
  }), { headers: { "Cache-Control": "private, no-store" } });
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request, 32 * 1024);
    const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const operation = body.operation;
    const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId.trim() : "";
    const yieldQuantity = Number(body.yieldQuantity);
    const inputs: Array<{ rawMaterialId?: unknown; quantityMilli?: unknown }> = Array.isArray(body.ingredients) ? body.ingredients : [];
    const access = await requirePermission(request, outletId, "inventory.adjust");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if ((operation !== "create" && operation !== "update") || !menuItemId || menuItemId.length > 80 || !Number.isSafeInteger(yieldQuantity) || yieldQuantity < 1 || yieldQuantity > 10000 || inputs.length < 1 || inputs.length > 50) {
      return NextResponse.json({ error: "Provide a menu item, a yield from 1 to 10000 portions, and 1–50 ingredients." }, { status: 400 });
    }
    const ingredients = inputs.map((entry) => ({ rawMaterialId: typeof entry.rawMaterialId === "string" ? entry.rawMaterialId.trim() : "", quantityMilli: quantityInput(entry.quantityMilli) }));
    if (ingredients.some((entry) => !entry.rawMaterialId || entry.rawMaterialId.length > 80 || entry.quantityMilli === null) || new Set(ingredients.map((entry) => entry.rawMaterialId)).size !== ingredients.length) {
      return NextResponse.json({ error: "Ingredient IDs must be unique and each quantity must be a positive integer in milli-units." }, { status: 400 });
    }

    const recipe = await prisma.$transaction(async (tx) => {
      const [menuItem, materials, previous] = await Promise.all([
        tx.menuItem.findFirst({ where: { id: menuItemId, tenantId: access.tenantId, active: true, outletPrices: { some: { outletId } } }, select: { id: true, name: true } }),
        tx.rawMaterial.findMany({ where: { id: { in: ingredients.map((entry) => entry.rawMaterialId) }, tenantId: access.tenantId, outletId }, select: { id: true, name: true, unit: true } }),
        tx.recipe.findUnique({
          where: { outletId_menuItemId: { outletId, menuItemId } },
          include: { ingredients: { include: { rawMaterial: { select: { id: true, name: true, quantityMilli: true } } } } },
        }),
      ]);
      if (!menuItem || materials.length !== ingredients.length) throw new RecipeNotFoundError();
      if (operation === "create" && previous) throw new RecipeAlreadyExistsError();
      if (operation === "update" && !previous) throw new RecipeNotFoundError();
      const ingredientRows = ingredients.map((entry) => ({ rawMaterialId: entry.rawMaterialId, quantityMilli: entry.quantityMilli! }));
      const include = {
        menuItem: { select: { id: true, name: true } },
        ingredients: { include: { rawMaterial: { select: { id: true, name: true, unit: true, quantityMilli: true } } } },
      };
      const saved = operation === "create"
        ? await tx.recipe.create({ data: { tenantId: access.tenantId, outletId, menuItemId, yieldQuantity, ingredients: { create: ingredientRows } }, include })
        : await tx.recipe.update({ where: { id: previous!.id }, data: { yieldQuantity, ingredients: { deleteMany: {}, create: ingredientRows } }, include });
      await tx.auditLog.create({ data: {
        tenantId: access.tenantId, outletId, userId: access.user.id, action: operation === "update" ? "RECIPE_UPDATED" : "RECIPE_CREATED", entityType: "Recipe", entityId: saved.id,
        before: previous ? { yieldQuantity: previous.yieldQuantity, ingredients: previous.ingredients.map((entry) => ({ rawMaterialId: entry.rawMaterialId, quantityMilli: entry.quantityMilli.toString() })) } : Prisma.JsonNull,
        after: { menuItemId, menuItemName: menuItem.name, yieldQuantity, ingredients: ingredients.map((entry) => ({ rawMaterialId: entry.rawMaterialId, quantityMilli: entry.quantityMilli!.toString() })) },
      } });
      return { saved, created: operation === "create" };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return NextResponse.json({ recipe: safeJson(recipe.saved) }, { status: recipe.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof RecipeAlreadyExistsError) return NextResponse.json({ error: "A recipe already exists for this menu item in the outlet. Refresh and edit the existing recipe." }, { status: 409 });
    if (error instanceof RecipeNotFoundError) return NextResponse.json({ error: "Menu item or ingredient was not found in this outlet." }, { status: 404 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return NextResponse.json({ error: "Recipe changed concurrently. Refresh and try again." }, { status: 409 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ error: "A recipe for this menu item was created concurrently. Refresh and try again." }, { status: 409 });
    console.error("KORA recipe update failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not save the recipe." }, { status: 500 });
  }
}

async function DELETEHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId")?.trim() ?? "";
  const menuItemId = request.nextUrl.searchParams.get("menuItemId")?.trim() ?? "";
  const access = await requirePermission(request, outletId, "inventory.adjust");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  if (!menuItemId || menuItemId.length > 80) return NextResponse.json({ error: "menuItemId is required." }, { status: 400 });
  try {
    await prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.findFirst({ where: { tenantId: access.tenantId, outletId, menuItemId }, include: { ingredients: true } });
      if (!recipe) throw new RecipeNotFoundError();
      await tx.recipe.delete({ where: { id: recipe.id } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "RECIPE_DELETED", entityType: "Recipe", entityId: recipe.id, before: { menuItemId, yieldQuantity: recipe.yieldQuantity, ingredients: recipe.ingredients.map((entry) => ({ rawMaterialId: entry.rawMaterialId, quantityMilli: entry.quantityMilli.toString() })) } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RecipeNotFoundError) return NextResponse.json({ error: "Recipe not found in this outlet." }, { status: 404 });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return NextResponse.json({ error: "Recipe changed concurrently. Refresh and try again." }, { status: 409 });
    return NextResponse.json({ error: "Could not remove the recipe." }, { status: 500 });
  }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
export const DELETE = withTenantScope(DELETEHandler);
