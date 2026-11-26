import { randomBytes } from "node:crypto";
import { PrismaClient, Plan, OrderType, OrderStatus, KOTStatus, PaymentStatus } from "@prisma/client";
import { hash } from "bcryptjs";
import { ensureKdsStations, ensureOutletSettings, ensureTenantSystemRoles } from "../src/lib/role-seed.js";

const prisma = new PrismaClient();

const sampleMenu = [
  { name: "Masala Dosa", category: "Breakfast", price: 18_000, isVeg: true },
  { name: "Idli Sambar", category: "Breakfast", price: 12_000, isVeg: true },
  { name: "Paneer Tikka", category: "Starters", price: 28_000, isVeg: true },
  { name: "Crispy Corn", category: "Starters", price: 22_000, isVeg: true },
  { name: "Butter Chicken", category: "Mains", price: 39_000, isVeg: false },
  { name: "Dal Makhani", category: "Mains", price: 29_000, isVeg: true },
  { name: "Butter Naan", category: "Breads", price: 6_000, isVeg: true },
  { name: "Garlic Naan", category: "Breads", price: 8_000, isVeg: true },
  { name: "Mango Lassi", category: "Drinks", price: 14_000, isVeg: true },
  { name: "Filter Coffee", category: "Drinks", price: 9_000, isVeg: true },
] as const;

const staffProfiles = [
  { key: "owner", name: "Demo Owner", role: "OWNER", outletIndex: 0 },
  { key: "manager-one", name: "Priya Menon", role: "RESTAURANT_MANAGER", outletIndex: 0 },
  { key: "manager-two", name: "Vikram Rao", role: "RESTAURANT_MANAGER", outletIndex: 1 },
  { key: "cashier-one", name: "Rohan Das", role: "CASHIER", outletIndex: 0 },
  { key: "cashier-two", name: "Nisha Shah", role: "CASHIER", outletIndex: 1 },
  { key: "waiter-one", name: "Dev Patel", role: "WAITER", outletIndex: 0 },
  { key: "waiter-two", name: "Isha Kapoor", role: "WAITER", outletIndex: 1 },
  { key: "chef", name: "Arun Kumar", role: "CHEF", outletIndex: 0 },
  { key: "accountant", name: "Meera Nair", role: "ACCOUNTANT", outletIndex: 1 },
  { key: "inventory", name: "Kabir Mehta", role: "INVENTORY_MANAGER", outletIndex: 0 },
] as const;

function demoEmail(key: string, ownerEmail: string | undefined) {
  if (key === "owner" && ownerEmail) return ownerEmail;
  if (ownerEmail) {
    const [local, domain] = ownerEmail.split("@");
    return `${local}+${key}@${domain}`;
  }
  return `${key}@demo.invalid`;
}

async function seedMenu(tenantId: string, outletId: string) {
  const stations = await prisma.station.findMany({ where: { outletId }, select: { id: true, name: true } });
  const stationByName = new Map(stations.map((station) => [station.name, station.id]));
  const categoryIds = new Map<string, string>();
  const categories = ["Breakfast", "Starters", "Mains", "Breads", "Drinks"];
  for (const [sortOrder, name] of categories.entries()) {
    const existing = await prisma.menuCategory.findFirst({ where: { tenantId, outletId, name } });
    const saved = existing ?? await prisma.menuCategory.create({ data: { tenantId, outletId, name, sortOrder } });
    categoryIds.set(name, saved.id);
  }

  for (const item of sampleMenu) {
    const categoryId = categoryIds.get(item.category)!;
    const existing = await prisma.menuItem.findFirst({ where: { tenantId, categoryId, name: item.name } });
    const saved = existing ?? await prisma.menuItem.create({ data: { tenantId, categoryId, name: item.name, basePricePaise: BigInt(item.price), isVeg: item.isVeg, gstBps: 500 } });
    const stationName = item.category === "Starters" || item.category === "Mains" || item.category === "Breads" ? "Grill" : "General";
    await prisma.outletMenuItem.upsert({
      where: { outletId_menuItemId: { outletId, menuItemId: saved.id } },
      update: { available: true, stationId: stationByName.get(stationName) ?? null },
      create: { outletId, menuItemId: saved.id, stationId: stationByName.get(stationName) ?? null, available: true },
    });
  }
  return prisma.menuItem.findMany({ where: { tenantId, category: { outletId } }, orderBy: { name: "asc" } });
}

async function seedTicket(input: {
  tenantId: string;
  outletId: string;
  outletCode: string;
  index: number;
  menuItemId: string;
  tableId?: string;
  createdById: string;
  waiterName: string;
  stationId: string;
  status: typeof KOTStatus[keyof typeof KOTStatus];
}) {
  const itemState = input.status === KOTStatus.READY ? "READY" : input.status === KOTStatus.QUEUED ? "QUEUED" : "COOKING";
  const idempotencyKey = `seed-kot-${input.outletCode}-${input.index}`;
  const existing = await prisma.order.findUnique({ where: { outletId_idempotencyKey: { outletId: input.outletId, idempotencyKey } }, include: { items: true, kots: true } });
  const status = input.status === KOTStatus.READY ? OrderStatus.READY : OrderStatus.PREPARING;
  if (existing) {
    await prisma.order.update({ where: { id: existing.id }, data: { status } });
    const kot = existing.kots.find((ticket) => ticket.sequence === 1);
    if (kot) {
      const tableLabel = input.tableId ? await prisma.restaurantTable.findUnique({ where: { id: input.tableId }, select: { label: true } }).then((table) => table?.label ?? null) : null;
      await prisma.kOT.update({ where: { id: kot.id }, data: { outletId: input.outletId, stationId: input.stationId, orderType: input.tableId ? OrderType.DINE_IN : OrderType.TAKEAWAY, tableLabel, waiterName: input.waiterName, status: input.status, startedAt: itemState === "QUEUED" ? null : existing.createdAt, ...(input.status === KOTStatus.READY ? { readyAt: new Date() } : { readyAt: null }) } });
      await prisma.kOTItem.updateMany({ where: { kotId: kot.id }, data: { status: input.status, state: itemState } });
    }
    return;
  }

  const sequence = await prisma.outlet.update({ where: { id: input.outletId }, data: { orderNextNumber: { increment: 1 } }, select: { orderNextNumber: true } });
  const orderNumber = sequence.orderNextNumber - 1;
  const kotSequence = await prisma.outlet.update({ where: { id: input.outletId }, data: { kotNextNumber: { increment: 1 } }, select: { kotNextNumber: true } });
  const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: input.menuItemId }, select: { id: true, name: true, basePricePaise: true, gstBps: true } });
  const createdAt = new Date(Date.now() - (input.index * 4 + 2) * 60_000);
  const order = await prisma.order.create({
    data: {
      tenantId: input.tenantId,
      outletId: input.outletId,
      orderNumber,
      type: input.tableId ? OrderType.DINE_IN : OrderType.TAKEAWAY,
      status,
      tableId: input.tableId,
      createdById: input.createdById,
      source: "SEED",
      deviceId: "seed-device",
      idempotencyKey,
      subtotalPaise: item.basePricePaise,
      taxPaise: BigInt(Math.round(Number(item.basePricePaise) * item.gstBps / 10_000)),
      totalPaise: item.basePricePaise + BigInt(Math.round(Number(item.basePricePaise) * item.gstBps / 10_000)),
      createdAt,
      items: { create: { menuItemId: item.id, nameSnapshot: item.name, quantity: 1, unitPricePaise: item.basePricePaise, gstBps: item.gstBps, totalPaise: item.basePricePaise } },
    },
    include: { items: true },
  });
  await prisma.kOT.create({
    data: {
      orderId: order.id,
      outletId: input.outletId,
      stationId: input.stationId,
      sequence: 1,
      kotNumber: kotSequence.kotNextNumber - 1,
      orderType: input.tableId ? OrderType.DINE_IN : OrderType.TAKEAWAY,
      tableLabel: input.tableId ? await prisma.restaurantTable.findUnique({ where: { id: input.tableId }, select: { label: true } }).then((table) => table?.label ?? null) : null,
      waiterName: input.waiterName,
      status: input.status,
      sentAt: createdAt,
      createdAt,
      startedAt: itemState === "QUEUED" ? null : createdAt,
      readyAt: input.status === KOTStatus.READY ? new Date() : null,
      items: { create: order.items.map((orderItem) => ({ orderItemId: orderItem.id, quantity: orderItem.quantity, status: input.status, state: itemState })) },
    },
  });
}

async function main() {
  const ownerEmail = process.env.SEED_OWNER_EMAIL?.trim().toLowerCase();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD;
  if (ownerEmail && (!/^\S+@\S+\.\S+$/.test(ownerEmail) || !ownerPassword || Array.from(ownerPassword).length < 12 || Buffer.byteLength(ownerPassword, "utf8") > 72)) {
    throw new Error("SEED_OWNER_EMAIL and a 12–72 byte SEED_OWNER_PASSWORD are both required to create a demo login.");
  }

  const tenant = await prisma.tenant.upsert({
    where: { slug: "saffron-room-demo" },
    update: { name: "The Saffron Room" },
    create: { name: "The Saffron Room", slug: "saffron-room-demo", plan: Plan.FREE },
  });
  const outlets = await Promise.all([
    prisma.outlet.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "BLR-IND" } },
      update: { name: "Indiranagar" },
      create: { tenantId: tenant.id, name: "Indiranagar", code: "BLR-IND", gstin: "29AAXXX1234X1Z5", address: { line1: "12th Main Road", city: "Bengaluru", state: "Karnataka", pincode: "560038" } },
    }),
    prisma.outlet.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: "BLR-KOR" } },
      update: { name: "Koramangala" },
      create: { tenantId: tenant.id, name: "Koramangala", code: "BLR-KOR", gstin: "29AAXXX1234X1Z5", address: { line1: "80 Feet Road", city: "Bengaluru", state: "Karnataka", pincode: "560095" } },
    }),
  ]);
  await prisma.$transaction(async (tx) => {
    const roles = await ensureTenantSystemRoles(tx, tenant.id);
    for (const outlet of outlets) {
      await ensureOutletSettings(tx, outlet.id);
      await ensureKdsStations(tx, outlet.id);
      await tx.restaurantTable.createMany({ data: Array.from({ length: 10 }, (_, index) => ({ outletId: outlet.id, label: `T-${String(index + 1).padStart(2, "0")}`, capacity: index < 4 ? 2 : 4 })), skipDuplicates: true });
    }
    return roles;
  });

  const menus = await Promise.all(outlets.map((outlet) => seedMenu(tenant.id, outlet.id)));
  const ownerPasswordHash = ownerPassword ? await hash(ownerPassword, 12) : null;
  const seededUsers = new Map<string, string>();
  for (const profile of staffProfiles) {
    const email = demoEmail(profile.key, ownerEmail);
    const passwordHash = profile.key === "owner" && ownerPasswordHash
      ? ownerPasswordHash
      : await hash(randomBytes(32).toString("base64url"), 12);
    const user = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      update: { name: profile.name, ...(profile.key === "owner" && ownerPasswordHash ? { passwordHash: ownerPasswordHash } : {}), active: true },
      create: { tenantId: tenant.id, name: profile.name, email, passwordHash },
    });
    seededUsers.set(profile.key, user.id);
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenant.id, name: profile.role } } });
    const outlet = outlets[profile.outletIndex];
    await prisma.userOutletRole.upsert({
      where: { userId_outletId_roleId: { userId: user.id, outletId: outlet.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, outletId: outlet.id, roleId: role.id },
    });
    if (profile.key === "owner") {
      for (const otherOutlet of outlets) await prisma.userOutletRole.upsert({
        where: { userId_outletId_roleId: { userId: user.id, outletId: otherOutlet.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, outletId: otherOutlet.id, roleId: role.id },
      });
    }
  }

  await prisma.shift.upsert({
    where: { outletId_userId_activeKey: { outletId: outlets[0].id, userId: seededUsers.get("cashier-one")!, activeKey: "seed-open-shift" } },
    update: {},
    create: { tenantId: tenant.id, outletId: outlets[0].id, userId: seededUsers.get("cashier-one")!, activeKey: "seed-open-shift", status: "OPEN", openingCashPaise: 50_000n },
  });

  const tables = await Promise.all(outlets.map((outlet) => prisma.restaurantTable.findMany({ where: { outletId: outlet.id }, orderBy: { label: "asc" }, take: 3 })));
  const statuses = [KOTStatus.QUEUED, KOTStatus.PREPARING, KOTStatus.READY] as const;
  for (let outletIndex = 0; outletIndex < outlets.length; outletIndex++) {
    for (let index = 0; index < 3; index++) {
      await seedTicket({
        tenantId: tenant.id,
        outletId: outlets[outletIndex].id,
        outletCode: outlets[outletIndex].code,
        index,
        menuItemId: menus[outletIndex][index % menus[outletIndex].length].id,
        tableId: index === 0 ? tables[outletIndex][0]?.id : undefined,
        createdById: seededUsers.get(outletIndex === 0 ? "waiter-one" : "waiter-two")!,
        waiterName: outletIndex === 0 ? "Dev Patel" : "Isha Kapoor",
        stationId: (await prisma.station.findUniqueOrThrow({ where: { outletId_name: { outletId: outlets[outletIndex].id, name: index === 0 ? "General" : "Grill" } } })).id,
        status: statuses[index],
      });
    }
  }
  await prisma.auditLog.upsert({
    where: { id: "seed-audit-role-assignment" },
    update: {},
    create: { id: "seed-audit-role-assignment", tenantId: tenant.id, outletId: outlets[0].id, userId: seededUsers.get("owner")!, action: "SEED_COMPLETED", entityType: "Tenant", entityId: tenant.id, after: { outletCount: outlets.length, seededRoles: staffProfiles.length } },
  });
  console.log(`Seeded ${tenant.name} · ${outlets.length} outlets · ${staffProfiles.length} users · ${sampleMenu.length} menu items per outlet · ${outlets.length * 3} sample KOTs.`);
  if (!ownerPassword) console.warn("No demo owner login was configured. Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD only in a local development environment.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });
