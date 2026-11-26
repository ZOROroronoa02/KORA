import { PrismaClient, Plan } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "saffron-room-demo" },
    update: { name: "The Saffron Room" },
    create: { name: "The Saffron Room", slug: "saffron-room-demo", plan: Plan.FREE },
  });

  const outlet = await prisma.outlet.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "BLR-IND" } },
    update: { name: "Indiranagar" },
    create: { tenantId: tenant.id, name: "Indiranagar", code: "BLR-IND", gstin: "29AAXXX1234X1Z5", address: { line1: "12th Main Road", city: "Bengaluru", state: "Karnataka", pincode: "560038" } },
  });

  await prisma.restaurantTable.createMany({
    data: Array.from({ length: 10 }, (_, index) => ({ outletId: outlet.id, label: `T-${String(index + 1).padStart(2, "0")}`, capacity: index < 4 ? 2 : 4 })),
    skipDuplicates: true,
  });

  const categories = ["Breakfast", "Starters", "Mains", "Breads", "Drinks"];
  const categoryRecords = new Map<string, string>();
  for (const [sortOrder, name] of categories.entries()) {
    const record = await prisma.menuCategory.findFirst({ where: { tenantId: tenant.id, outletId: outlet.id, name } });
    const saved = record ?? await prisma.menuCategory.create({ data: { tenantId: tenant.id, outletId: outlet.id, name, sortOrder } });
    categoryRecords.set(name, saved.id);
  }

  const items = [
    { name: "Masala Dosa", category: "Breakfast", price: 18000, isVeg: true },
    { name: "Idli Sambar", category: "Breakfast", price: 12000, isVeg: true },
    { name: "Paneer Tikka", category: "Starters", price: 28000, isVeg: true },
    { name: "Crispy Corn", category: "Starters", price: 22000, isVeg: true },
    { name: "Butter Chicken", category: "Mains", price: 39000, isVeg: false },
    { name: "Dal Makhani", category: "Mains", price: 29000, isVeg: true },
    { name: "Butter Naan", category: "Breads", price: 6000, isVeg: true },
    { name: "Garlic Naan", category: "Breads", price: 8000, isVeg: true },
    { name: "Mango Lassi", category: "Drinks", price: 14000, isVeg: true },
    { name: "Filter Coffee", category: "Drinks", price: 9000, isVeg: true },
  ];
  for (const item of items) {
    const existing = await prisma.menuItem.findFirst({ where: { tenantId: tenant.id, categoryId: categoryRecords.get(item.category), name: item.name } });
    const saved = existing ?? await prisma.menuItem.create({ data: { tenantId: tenant.id, categoryId: categoryRecords.get(item.category)!, name: item.name, basePricePaise: BigInt(item.price), isVeg: item.isVeg, gstBps: 500 } });
    await prisma.outletMenuItem.upsert({ where: { outletId_menuItemId: { outletId: outlet.id, menuItemId: saved.id } }, update: { available: true }, create: { outletId: outlet.id, menuItemId: saved.id } });
  }

  const roleNames = ["Owner", "Manager", "Cashier", "Waiter", "Kitchen"];
  const permissions = ["order.create", "order.discount", "order.void", "bill.refund", "bill.split", "shift.open", "shift.close", "menu.manage", "inventory.manage", "reports.view", "team.manage", "customer.manage", "kot.update"];
  const permissionRecords = await Promise.all(permissions.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key.replaceAll(".", " ") } })));
  const roleAccess: Record<string, string[]> = {
    Owner: permissions,
    Manager: ["order.create", "order.discount", "order.void", "bill.refund", "bill.split", "shift.open", "shift.close", "menu.manage", "inventory.manage", "reports.view", "customer.manage", "kot.update"],
    Cashier: ["order.create", "bill.split", "shift.open", "shift.close"],
    Waiter: ["order.create"],
    Kitchen: ["kot.update"],
  };
  for (const name of roleNames) {
    const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId: tenant.id, name } }, update: {}, create: { tenantId: tenant.id, name, isSystem: true } });
    const granted = new Set(roleAccess[name]);
    await Promise.all(permissionRecords.filter((permission) => granted.has(permission.key)).map((permission) => prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, update: {}, create: { roleId: role.id, permissionId: permission.id } })));
  }
  const seedEmail = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
  const seedPassword = process.env.SEED_OWNER_PASSWORD;
  if (seedEmail && seedPassword) {
    if (Array.from(seedPassword).length < 12 || Buffer.byteLength(seedPassword, "utf8") > 72) throw new Error("SEED_OWNER_PASSWORD must contain at least 12 characters and at most 72 UTF-8 bytes.");
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenant.id, name: "Owner" } } });
    const passwordHash = await hash(seedPassword, 12);
    const owner = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: seedEmail } },
      update: { name: "Demo Owner", passwordHash, active: true },
      create: { tenantId: tenant.id, name: "Demo Owner", email: seedEmail, passwordHash },
    });
    await prisma.userOutletRole.upsert({
      where: { userId_outletId_roleId: { userId: owner.id, outletId: outlet.id, roleId: ownerRole.id } },
      update: {},
      create: { userId: owner.id, outletId: outlet.id, roleId: ownerRole.id },
    });
  } else {
    console.warn("No demo login was created. Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD in the local environment.");
  }
  console.log(`Seeded ${tenant.name} · ${outlet.name} · 5 categories · ${items.length} menu items`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
