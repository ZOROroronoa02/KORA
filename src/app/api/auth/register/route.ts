import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { accessTokenSeconds, createAccessToken, hashToken, newRefreshToken, refreshCookie } from "@/lib/server-auth";
import { isRateLimited } from "@/lib/rate-limit";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const throttle = await isRateLimited(request, "register", 5, 3600);
    if (throttle.limited) return NextResponse.json({ error: "Too many account setup attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(throttle.retryAfter) } });
    const body = await readJsonObject(request);
    const tenantName = typeof body.tenantName === "string" ? body.tenantName.trim() : "";
    const outletName = typeof body.outletName === "string" ? body.outletName.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : null;
    if (tenantName.length < 2 || outletName.length < 2 || name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
      return NextResponse.json({ error: "Provide restaurant, outlet, owner name, a valid email, and a password of at least 12 characters." }, { status: 400 });
    }
    const baseSlug = tenantName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "restaurant";
    const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
    const permissions = ["order.create", "order.discount", "order.void", "bill.refund", "bill.split", "shift.open", "shift.close", "menu.manage", "inventory.manage", "reports.view", "team.manage", "kot.update"];
    const passwordHash = await hash(password, 12);
    const created = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: tenantName, slug } });
      const outlet = await tx.outlet.create({ data: { tenantId: tenant.id, name: outletName, code: "MAIN" } });
      const user = await tx.user.create({ data: { tenantId: tenant.id, name, email, phone, passwordHash } });
      const categoryNames = ["Breakfast", "Starters", "Mains", "Breads", "Drinks"];
      const categoryIds = new Map<string, string>();
      for (const [sortOrder, categoryName] of categoryNames.entries()) {
        const category = await tx.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name: categoryName, sortOrder } });
        categoryIds.set(categoryName, category.id);
      }
      await tx.restaurantTable.createMany({ data: Array.from({ length: 10 }, (_, index) => ({ outletId: outlet.id, label: `T-${String(index + 1).padStart(2, "0")}`, capacity: index < 4 ? 2 : 4 })) });
      if (body.sampleMenu !== false) {
        const sampleItems = [
          ["Masala Dosa", "Breakfast", 18000, true], ["Idli Sambar", "Breakfast", 12000, true],
          ["Paneer Tikka", "Starters", 28000, true], ["Crispy Corn", "Starters", 22000, true],
          ["Butter Chicken", "Mains", 39000, false], ["Dal Makhani", "Mains", 29000, true],
          ["Butter Naan", "Breads", 6000, true], ["Garlic Naan", "Breads", 8000, true],
          ["Mango Lassi", "Drinks", 14000, true], ["Filter Coffee", "Drinks", 9000, true],
        ] as const;
        for (const [itemName, categoryName, pricePaise, isVeg] of sampleItems) {
          const item = await tx.menuItem.create({ data: { tenantId: tenant.id, categoryId: categoryIds.get(categoryName)!, name: itemName, basePricePaise: BigInt(pricePaise), gstBps: 500, isVeg } });
          await tx.outletMenuItem.create({ data: { outletId: outlet.id, menuItemId: item.id, available: true } });
        }
      }
      const role = await tx.role.create({ data: { tenantId: tenant.id, name: "Owner", isSystem: true } });
      const permissionRows = await Promise.all(permissions.map((key) => tx.permission.upsert({ where: { key }, update: {}, create: { key, description: key.replaceAll(".", " ") } })));
      await tx.rolePermission.createMany({ data: permissionRows.map((permission) => ({ roleId: role.id, permissionId: permission.id })), skipDuplicates: true });
      await tx.userOutletRole.create({ data: { userId: user.id, outletId: outlet.id, roleId: role.id } });
      const roleAccess: Record<string, string[]> = {
        Manager: ["order.create", "order.discount", "order.void", "bill.refund", "bill.split", "shift.open", "shift.close", "menu.manage", "inventory.manage", "reports.view", "kot.update"],
        Cashier: ["order.create", "bill.split", "shift.open", "shift.close"], Waiter: ["order.create"], Kitchen: ["kot.update"],
      };
      for (const [roleName, allowed] of Object.entries(roleAccess)) {
        const employeeRole = await tx.role.create({ data: { tenantId: tenant.id, name: roleName, isSystem: true } });
        const granted = permissionRows.filter((permission) => allowed.includes(permission.key));
        await tx.rolePermission.createMany({ data: granted.map((permission) => ({ roleId: employeeRole.id, permissionId: permission.id })), skipDuplicates: true });
      }
      return { tenant, outlet, user };
    });
    const refresh = newRefreshToken();
    await prisma.refreshToken.create({ data: { userId: created.user.id, tokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    const accessToken = await createAccessToken(created.user);
    const response = NextResponse.json({ accessToken, expiresIn: accessTokenSeconds, tenant: { id: created.tenant.id, name: created.tenant.name, slug: created.tenant.slug }, outlet: { id: created.outlet.id, name: created.outlet.name }, user: { id: created.user.id, name: created.user.name, email: created.user.email } }, { status: 201 });
    response.headers.set("set-cookie", refreshCookie(refresh, 30 * 24 * 60 * 60));
    return response;
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof Error && error.message.includes("JWT_ACCESS_SECRET")) return NextResponse.json({ error: error.message }, { status: 503 });
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return NextResponse.json({ error: "That email or restaurant already exists." }, { status: 409 });
    return NextResponse.json({ error: "Could not create the restaurant account." }, { status: 500 });
  }
}
