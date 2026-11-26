import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const permission = await prisma.permission.upsert({
    where: { key: "customer.manage" },
    update: {},
    create: { key: "customer.manage", description: "customer manage" },
  });
  const roles = await prisma.role.findMany({
    where: { isSystem: true, name: { in: ["Owner", "Manager"] } },
    select: { id: true },
  });
  const result = await prisma.rolePermission.createMany({
    data: roles.map((role) => ({ roleId: role.id, permissionId: permission.id })),
    skipDuplicates: true,
  });
  console.log(`customer.manage present on ${roles.length} system roles; granted ${result.count} new assignments`);
}

main().catch((error) => { console.error("Customer permission backfill failed.", error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
