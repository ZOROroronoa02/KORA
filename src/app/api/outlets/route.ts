import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/server-auth";
import { prisma, rootPrisma } from "@/lib/prisma";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { ensureOutletSettings } from "@/lib/role-seed";
import { exceedsPlanLimit, planLimit } from "@/lib/domain/plan-limits";

export const runtime = "nodejs";

class PlanLimitReachedError extends Error {
  constructor(readonly resource: "outlets" | "users", readonly limit: number) {
    super(`The current plan allows up to ${limit} ${resource}.`);
  }
}

function outletCodeFrom(name: string) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 12) || "OUTLET";
}

async function createOutletWithCopiedMenu(input: {
  tenantId: string;
  sourceOutletId: string;
  name: string;
  code: string;
  actorUserId: string;
}) {
  // Provisioning writes across the new outlet boundary, so it uses the unscoped
  // client only inside this transaction and adds explicit tenant/outlet predicates.
  return rootPrisma.$transaction(async (tx) => {
    // Serialize provisioning for a tenant so concurrent requests cannot both pass
    // the count check and exceed the plan's outlet limit.
    const lockedTenant = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "tenants" WHERE "id" = ${input.tenantId} FOR UPDATE
    `;
    if (!lockedTenant.length) throw new Error("Tenant not found.");

    const tenant = await tx.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, plan: true } });
    if (!tenant) throw new Error("Tenant not found.");
    const source = await tx.outlet.findFirst({ where: { id: input.sourceOutletId, tenantId: input.tenantId }, select: { id: true } });
    if (!source) throw new Error("Source outlet not found.");

    const currentOutlets = await tx.outlet.count({ where: { tenantId: input.tenantId } });
    if (exceedsPlanLimit(tenant.plan, "outlets", currentOutlets)) {
      throw new PlanLimitReachedError("outlets", planLimit(tenant.plan, "outlets"));
    }

    const ownerRole = await tx.role.findFirst({ where: { tenantId: input.tenantId, outletId: null, name: "OWNER", isSystem: true }, select: { id: true } });
    if (!ownerRole) throw new Error("Tenant owner role is not configured.");

    const outlet = await tx.outlet.create({ data: { tenantId: input.tenantId, name: input.name, code: input.code } });
    await ensureOutletSettings(tx, outlet.id);

    const sourceStations = await tx.station.findMany({
      where: { outletId: input.sourceOutletId, active: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, sortOrder: true },
    });
    const stationSources = sourceStations.length ? sourceStations : [{ id: "", name: "General", sortOrder: 0 }];
    const stationBySourceId = new Map<string, string>();
    const stationByName = new Map<string, string>();
    for (const station of stationSources) {
      const created = await tx.station.create({ data: { outletId: outlet.id, name: station.name, sortOrder: station.sortOrder } });
      stationByName.set(station.name, created.id);
      if (station.id) stationBySourceId.set(station.id, created.id);
    }

    const sourceCategories = await tx.menuCategory.findMany({
      where: { tenantId: input.tenantId, OR: [{ outletId: input.sourceOutletId }, { outletId: null }], active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, sortOrder: true, parentId: true },
    });
    const categoriesToCopy = sourceCategories.length ? sourceCategories : [
      { id: "fallback-breakfast", name: "Breakfast", sortOrder: 0, parentId: null },
      { id: "fallback-mains", name: "Mains", sortOrder: 1, parentId: null },
      { id: "fallback-drinks", name: "Drinks", sortOrder: 2, parentId: null },
    ];
    const categoryIds = new Map<string, string>();
    for (const category of categoriesToCopy) {
      const created = await tx.menuCategory.create({
        data: {
          tenantId: input.tenantId,
          outletId: outlet.id,
          name: category.name,
          sortOrder: category.sortOrder,
        },
      });
      categoryIds.set(category.id, created.id);
    }
    for (const category of sourceCategories) {
      const categoryId = categoryIds.get(category.id);
      const parentId = category.parentId ? categoryIds.get(category.parentId) : undefined;
      if (categoryId && parentId) await tx.menuCategory.update({ where: { id: categoryId }, data: { parentId } });
    }

    if (sourceCategories.length) {
      const sourceItems = await tx.menuItem.findMany({
        where: { tenantId: input.tenantId, categoryId: { in: sourceCategories.map((category) => category.id) }, active: true },
        include: {
          variants: true,
          addons: true,
          happyHours: true,
          outletPrices: { where: { outletId: input.sourceOutletId }, select: { stationId: true, pricePaise: true, available: true } },
        },
        orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
      });

      for (const item of sourceItems) {
        const categoryId = categoryIds.get(item.categoryId);
        if (!categoryId) continue;
        const sourcePrice = item.outletPrices[0];
        const stationId = sourcePrice?.stationId ? stationBySourceId.get(sourcePrice.stationId) : undefined;
        await tx.menuItem.create({
          data: {
            tenantId: input.tenantId,
            categoryId,
            name: item.name,
            description: item.description,
            imageUrl: item.imageUrl,
            basePricePaise: item.basePricePaise,
            gstBps: item.gstBps,
            taxCodeKind: item.taxCodeKind,
            taxCode: item.taxCode,
            isVeg: item.isVeg,
            active: item.active,
            variants: { create: item.variants.map(({ name, priceDeltaPaise, active }) => ({ name, priceDeltaPaise, active })) },
            addons: { create: item.addons.map(({ name, pricePaise, active }) => ({ name, pricePaise, active })) },
            happyHours: { create: item.happyHours.map(({ startsAt, endsAt, daysOfWeek, discountBps }) => ({ startsAt, endsAt, daysOfWeek, discountBps })) },
            outletPrices: {
              create: {
                outletId: outlet.id,
                stationId: stationId ?? stationByName.get("General") ?? stationByName.values().next().value,
                pricePaise: sourcePrice?.pricePaise ?? null,
                available: sourcePrice?.available ?? true,
              },
            },
          },
        });
      }
    }

    const tables = await tx.restaurantTable.findMany({
      where: { outletId: input.sourceOutletId, active: true },
      orderBy: { label: "asc" },
      select: { label: true, section: true, capacity: true },
    });
    const tableSeed = tables.length ? tables : Array.from({ length: 10 }, (_, index) => ({ label: `T-${String(index + 1).padStart(2, "0")}`, section: null, capacity: index < 4 ? 2 : 4 }));
    await tx.restaurantTable.createMany({ data: tableSeed.map((table) => ({ outletId: outlet.id, ...table })) });
    await tx.userOutletRole.create({ data: { userId: input.actorUserId, outletId: outlet.id, roleId: ownerRole.id } });
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        outletId: outlet.id,
        userId: input.actorUserId,
        action: "OUTLET_CREATED",
        entityType: "Outlet",
        entityId: outlet.id,
        after: { name: outlet.name, code: outlet.code, copiedFromOutletId: input.sourceOutletId, menuItemsCopied: sourceCategories.length > 0 },
      },
    });
    return outlet;
  }, { maxWait: 10_000, timeout: 30_000 });
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request, 8 * 1024);
    const sourceOutletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    const requestedCode = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const access = await requirePermission(request, sourceOutletId, "outlets.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (name.length < 2 || name.length > 80) return NextResponse.json({ error: "Outlet name must be 2–80 characters." }, { status: 400 });

    const ownerAssignment = await prisma.userOutletRole.findFirst({
      where: {
        userId: access.user.id,
        outletId: sourceOutletId,
        role: { tenantId: access.tenantId, outletId: null, name: "OWNER", isSystem: true },
      },
      select: { userId: true },
    });
    if (!ownerAssignment) return NextResponse.json({ error: "Only a tenant owner can create an outlet." }, { status: 403 });

    const code = requestedCode || outletCodeFrom(name);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,11}$/.test(code)) return NextResponse.json({ error: "Outlet code must be 2–12 letters, numbers, hyphens, or underscores." }, { status: 400 });
    const outlet = await createOutletWithCopiedMenu({ tenantId: access.tenantId, sourceOutletId, name, code, actorUserId: access.user.id });
    return NextResponse.json({ outlet: { id: outlet.id, name: outlet.name, code: outlet.code }, message: "Outlet created with a copy of the source menu and tables. Inventory starts empty." }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof PlanLimitReachedError) return NextResponse.json({ error: error.message, code: "PLAN_LIMIT_REACHED", resource: error.resource, limit: error.limit }, { status: 409 });
    if (error instanceof Error && error.message.includes("Tenant not found")) return NextResponse.json({ error: "Restaurant account not found." }, { status: 404 });
    if (error instanceof Error && error.message.includes("Source outlet not found")) return NextResponse.json({ error: "Source outlet was not found in this restaurant." }, { status: 404 });
    if (error instanceof Error && error.message.includes("owner role is not configured")) return NextResponse.json({ error: "Tenant owner role is not configured." }, { status: 503 });
    if (error instanceof Error && "code" in error && error.code === "P2002") return NextResponse.json({ error: "An outlet with this code already exists." }, { status: 409 });
    return NextResponse.json({ error: "Could not create outlet." }, { status: 500 });
  }
}

export const POST = withTenantScope(POSTHandler);
