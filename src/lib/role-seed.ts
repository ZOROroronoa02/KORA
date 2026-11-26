import type { Prisma } from "@prisma/client";
import {
  permissionDescriptions,
  roleNames,
  superAdminPermissions,
  systemRolePermissions,
} from "@/lib/permissions";

export const defaultOutletSettings = {
  discountApprovalThresholdPct: 10,
  voidRequiresApproval: false,
  slaMinutesPerOrderType: { DINE_IN: 15, TAKEAWAY: 15, DELIVERY: 20 },
  kdsSoundEnabled: true,
  hiddenReports: {},
};

export async function ensureTenantSystemRoles(tx: Prisma.TransactionClient, tenantId: string) {
  const permissionRows = await Promise.all(Object.entries(permissionDescriptions).map(([key, description]) =>
    tx.permission.upsert({ where: { key }, update: { description }, create: { key, description } }),
  ));
  const permissionByKey = new Map(permissionRows.map((permission) => [permission.key, permission.id]));

  const roles = new Map<string, string>();
  for (const name of roleNames) {
    const role = await tx.role.upsert({
      where: { tenantId_name: { tenantId, name } },
      update: { isSystem: true, description: `KORA system role: ${name.replaceAll("_", " ")}`, outletId: null },
      create: { tenantId, name, isSystem: true, description: `KORA system role: ${name.replaceAll("_", " ")}` },
    });
    const grants = systemRolePermissions[name].map((key) => permissionByKey.get(key)!).filter(Boolean);
    await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: grants } } });
    if (grants.length) {
      await tx.rolePermission.createMany({ data: grants.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true });
    }
    roles.set(name, role.id);
  }

  const superAdmin = await tx.role.upsert({
    where: { id: "kora-system-super-admin" },
    update: { tenantId: null, outletId: null, name: "SUPER_ADMIN", isSystem: true, description: "Platform administrator across tenant boundaries" },
    create: { id: "kora-system-super-admin", tenantId: null, name: "SUPER_ADMIN", isSystem: true, description: "Platform administrator across tenant boundaries" },
  });
  const platformGrants = superAdminPermissions.map((key) => permissionByKey.get(key)!).filter(Boolean);
  await tx.rolePermission.deleteMany({ where: { roleId: superAdmin.id, permissionId: { notIn: platformGrants } } });
  await tx.rolePermission.createMany({ data: platformGrants.map((permissionId) => ({ roleId: superAdmin.id, permissionId })), skipDuplicates: true });

  return { roles, permissions: permissionByKey, superAdmin };
}

export async function ensureOutletSettings(tx: Prisma.TransactionClient, outletId: string) {
  return tx.outletSettings.upsert({
    where: { outletId },
    update: {},
    create: { outletId, settings: defaultOutletSettings },
  });
}
