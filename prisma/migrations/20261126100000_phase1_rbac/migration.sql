-- Down migration: see rollback.sql; restore the database backup before rollback.
-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "approvalPinHash" TEXT;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS "outletId" TEXT,
ALTER COLUMN "tenantId" DROP NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_platform_roles" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_platform_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "outlet_settings" (
    "outletId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlet_settings_pkey" PRIMARY KEY ("outletId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_platform_roles_roleId_idx" ON "user_platform_roles"("roleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "roles_outletId_idx" ON "roles"("outletId");

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_outletId_fkey') THEN ALTER TABLE "roles" ADD CONSTRAINT "roles_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_platform_roles_userId_fkey') THEN ALTER TABLE "user_platform_roles" ADD CONSTRAINT "user_platform_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_platform_roles_roleId_fkey') THEN ALTER TABLE "user_platform_roles" ADD CONSTRAINT "user_platform_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outlet_settings_outletId_fkey') THEN ALTER TABLE "outlet_settings" ADD CONSTRAINT "outlet_settings_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_approvalUserId_fkey') THEN ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_approvalUserId_fkey" FOREIGN KEY ("approvalUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;


-- Populate the new dot-namespaced permission catalog while preserving custom-role grants.
INSERT INTO "permissions" ("id", "key", "description") VALUES
('kora-permission-orders-read', 'orders.read', 'Read orders in the assigned outlet'),
('kora-permission-orders-create', 'orders.create', 'Create orders'),
('kora-permission-orders-edit', 'orders.edit', 'Edit active orders'),
('kora-permission-orders-void', 'orders.void', 'Void unpaid orders'),
('kora-permission-orders-move_table', 'orders.move_table', 'Move a dine-in order to another table'),
('kora-permission-orders-merge', 'orders.merge', 'Merge tables or orders'),
('kora-permission-kot-print', 'kot.print', 'Print a kitchen order ticket'),
('kora-permission-kot-reprint', 'kot.reprint', 'Reprint a kitchen order ticket'),
('kora-permission-bills-create', 'bills.create', 'Create bills'),
('kora-permission-bills-settle', 'bills.settle', 'Record bill payments'),
('kora-permission-bills-split', 'bills.split', 'Split a bill'),
('kora-permission-bills-discount-apply', 'bills.discount.apply', 'Apply discounts within the configured threshold'),
('kora-permission-bills-discount-approve', 'bills.discount.approve', 'Approve discounts above the configured threshold'),
('kora-permission-bills-void', 'bills.void', 'Void bills'),
('kora-permission-bills-day_close', 'bills.day_close', 'Close the business day'),
('kora-permission-bills-refund', 'bills.refund', 'Record payment reversals'),
('kora-permission-shift-open', 'shift.open', 'Open a cashier shift'),
('kora-permission-shift-close', 'shift.close', 'Close a cashier shift'),
('kora-permission-menu-view', 'menu.view', 'View the outlet menu'),
('kora-permission-menu-edit', 'menu.edit', 'Edit menu items and availability'),
('kora-permission-menu-price_edit', 'menu.price_edit', 'Change menu prices'),
('kora-permission-reports-view-sales', 'reports.view.sales', 'View sales reports'),
('kora-permission-reports-view-financial', 'reports.view.financial', 'View financial reports'),
('kora-permission-reports-view-gst', 'reports.view.gst', 'View GST reports'),
('kora-permission-reports-view-staff_performance', 'reports.view.staff_performance', 'View staff performance reports'),
('kora-permission-reports-view-kds_sla', 'reports.view.kds_sla', 'View kitchen SLA reports'),
('kora-permission-kds-view', 'kds.view', 'View kitchen tickets'),
('kora-permission-kds-bump', 'kds.bump', 'Advance kitchen ticket state'),
('kora-permission-kds-recall', 'kds.recall', 'Recall a kitchen ticket'),
('kora-permission-kds-hold', 'kds.hold', 'Hold a kitchen ticket'),
('kora-permission-inventory-view', 'inventory.view', 'View outlet inventory'),
('kora-permission-inventory-adjust', 'inventory.adjust', 'Adjust outlet stock'),
('kora-permission-staff-manage', 'staff.manage', 'Manage outlet team members'),
('kora-permission-roles-manage', 'roles.manage', 'Manage outlet roles and permissions'),
('kora-permission-settings-manage', 'settings.manage', 'Manage outlet settings'),
('kora-permission-outlets-manage', 'outlets.manage', 'Manage outlets'),
('kora-permission-audit-view', 'audit.view', 'View sensitive-action audit history'),
('kora-permission-customers-view', 'customers.view', 'View customer profiles'),
('kora-permission-customers-manage', 'customers.manage', 'Create and update customer profiles')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";

-- Copy grants from legacy permission keys to their new fine-grained equivalents.
WITH permission_map (legacy_key, target_key) AS (VALUES
('order.create', 'orders.create'),
('order.discount', 'bills.discount.apply'),
('order.void', 'orders.void'),
('bill.refund', 'bills.refund'),
('bill.split', 'bills.split'),
('menu.manage', 'menu.edit'),
('inventory.manage', 'inventory.view'),
('inventory.manage', 'inventory.adjust'),
('reports.view', 'reports.view.sales'),
('reports.view', 'reports.view.financial'),
('reports.view', 'reports.view.gst'),
('reports.view', 'reports.view.staff_performance'),
('reports.view', 'reports.view.kds_sla'),
('team.manage', 'staff.manage'),
('customer.manage', 'customers.view'),
('customer.manage', 'customers.manage'),
('kot.update', 'kds.view'),
('kot.update', 'kds.bump')
)
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT DISTINCT rp."roleId", target."id"
FROM "role_permissions" rp
JOIN "permissions" legacy ON legacy."id" = rp."permissionId"
JOIN permission_map mapping ON mapping.legacy_key = legacy."key"
JOIN "permissions" target ON target."key" = mapping.target_key
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Rename old built-in roles in place; merge role links if a canonical role already exists.
DO $$
DECLARE old_role RECORD; target_id TEXT; canonical_name TEXT; role_map RECORD;
BEGIN
  FOR role_map IN SELECT * FROM (VALUES ('Owner', 'OWNER'), ('Manager', 'RESTAURANT_MANAGER'), ('Cashier', 'CASHIER'), ('Waiter', 'WAITER'), ('Kitchen', 'CHEF'), ('Accountant', 'ACCOUNTANT'), ('Inventory Manager', 'INVENTORY_MANAGER')) AS aliases(old_name, new_name) LOOP
    FOR old_role IN SELECT "id", "tenantId" FROM "roles" WHERE "name" = role_map.old_name AND "tenantId" IS NOT NULL LOOP
      SELECT "id" INTO target_id FROM "roles" WHERE "tenantId" = old_role."tenantId" AND "name" = role_map.new_name AND "id" <> old_role."id" LIMIT 1;
      IF target_id IS NULL THEN
        UPDATE "roles" SET "name" = role_map.new_name, "isSystem" = TRUE, "description" = 'KORA system role: ' || replace(role_map.new_name, '_', ' ') WHERE "id" = old_role."id";
      ELSE
        INSERT INTO "role_permissions" ("roleId", "permissionId") SELECT target_id, "permissionId" FROM "role_permissions" WHERE "roleId" = old_role."id" ON CONFLICT DO NOTHING;
        INSERT INTO "user_outlet_roles" ("userId", "outletId", "roleId") SELECT "userId", "outletId", target_id FROM "user_outlet_roles" WHERE "roleId" = old_role."id" ON CONFLICT DO NOTHING;
        DELETE FROM "role_permissions" WHERE "roleId" = old_role."id";
        DELETE FROM "user_outlet_roles" WHERE "roleId" = old_role."id";
        DELETE FROM "roles" WHERE "id" = old_role."id";
      END IF;
      target_id := NULL;
    END LOOP;
  END LOOP;
END $$;

-- Ensure all tenants have their locked system roles and the global platform role.
INSERT INTO "roles" ("id", "tenantId", "outletId", "name", "isSystem", "description")
SELECT 'kora-system-' || md5(t."id" || ':' || role_def.name), t."id", NULL, role_def.name, TRUE, role_def.description
FROM "tenants" t CROSS JOIN (VALUES
('OWNER', 'KORA system role: OWNER'),
('RESTAURANT_MANAGER', 'KORA system role: RESTAURANT MANAGER'),
('CASHIER', 'KORA system role: CASHIER'),
('WAITER', 'KORA system role: WAITER'),
('CHEF', 'KORA system role: CHEF'),
('ACCOUNTANT', 'KORA system role: ACCOUNTANT'),
('INVENTORY_MANAGER', 'KORA system role: INVENTORY MANAGER')
) AS role_def(name, description)
ON CONFLICT ("tenantId", "name") DO UPDATE SET "isSystem" = TRUE, "outletId" = NULL, "description" = EXCLUDED."description";

INSERT INTO "roles" ("id", "tenantId", "outletId", "name", "isSystem", "description")
VALUES ('kora-system-super-admin', NULL, NULL, 'SUPER_ADMIN', TRUE, 'Platform administrator across tenant boundaries')
ON CONFLICT ("id") DO UPDATE SET "tenantId" = NULL, "outletId" = NULL, "name" = 'SUPER_ADMIN', "isSystem" = TRUE, "description" = EXCLUDED."description";

-- Replace built-in system grants with the reviewed defaults.
DELETE FROM "role_permissions" rp USING "roles" r WHERE rp."roleId" = r."id" AND r."isSystem" = TRUE;
WITH grants (role_name, permission_key) AS (VALUES
('OWNER', 'orders.read'),
('OWNER', 'orders.edit'),
('OWNER', 'orders.void'),
('OWNER', 'orders.move_table'),
('OWNER', 'orders.merge'),
('OWNER', 'kot.print'),
('OWNER', 'kot.reprint'),
('OWNER', 'bills.create'),
('OWNER', 'bills.settle'),
('OWNER', 'bills.split'),
('OWNER', 'bills.discount.apply'),
('OWNER', 'bills.discount.approve'),
('OWNER', 'bills.void'),
('OWNER', 'bills.day_close'),
('OWNER', 'bills.refund'),
('OWNER', 'shift.open'),
('OWNER', 'shift.close'),
('OWNER', 'menu.view'),
('OWNER', 'menu.edit'),
('OWNER', 'menu.price_edit'),
('OWNER', 'reports.view.sales'),
('OWNER', 'reports.view.financial'),
('OWNER', 'reports.view.gst'),
('OWNER', 'reports.view.staff_performance'),
('OWNER', 'reports.view.kds_sla'),
('OWNER', 'kds.view'),
('OWNER', 'kds.bump'),
('OWNER', 'kds.recall'),
('OWNER', 'kds.hold'),
('OWNER', 'inventory.view'),
('OWNER', 'inventory.adjust'),
('OWNER', 'staff.manage'),
('OWNER', 'roles.manage'),
('OWNER', 'settings.manage'),
('OWNER', 'outlets.manage'),
('OWNER', 'audit.view'),
('OWNER', 'customers.view'),
('OWNER', 'customers.manage'),
('RESTAURANT_MANAGER', 'orders.read'),
('RESTAURANT_MANAGER', 'orders.create'),
('RESTAURANT_MANAGER', 'orders.edit'),
('RESTAURANT_MANAGER', 'orders.void'),
('RESTAURANT_MANAGER', 'orders.move_table'),
('RESTAURANT_MANAGER', 'orders.merge'),
('RESTAURANT_MANAGER', 'bills.create'),
('RESTAURANT_MANAGER', 'bills.settle'),
('RESTAURANT_MANAGER', 'bills.split'),
('RESTAURANT_MANAGER', 'bills.discount.apply'),
('RESTAURANT_MANAGER', 'bills.void'),
('RESTAURANT_MANAGER', 'bills.day_close'),
('RESTAURANT_MANAGER', 'bills.refund'),
('RESTAURANT_MANAGER', 'bills.discount.approve'),
('RESTAURANT_MANAGER', 'shift.open'),
('RESTAURANT_MANAGER', 'shift.close'),
('RESTAURANT_MANAGER', 'menu.view'),
('RESTAURANT_MANAGER', 'menu.edit'),
('RESTAURANT_MANAGER', 'menu.price_edit'),
('RESTAURANT_MANAGER', 'kds.view'),
('RESTAURANT_MANAGER', 'kds.bump'),
('RESTAURANT_MANAGER', 'kds.recall'),
('RESTAURANT_MANAGER', 'kds.hold'),
('RESTAURANT_MANAGER', 'inventory.view'),
('RESTAURANT_MANAGER', 'inventory.adjust'),
('RESTAURANT_MANAGER', 'staff.manage'),
('RESTAURANT_MANAGER', 'customers.view'),
('RESTAURANT_MANAGER', 'customers.manage'),
('RESTAURANT_MANAGER', 'audit.view'),
('RESTAURANT_MANAGER', 'reports.view.sales'),
('RESTAURANT_MANAGER', 'reports.view.kds_sla'),
('CASHIER', 'orders.read'),
('CASHIER', 'orders.create'),
('CASHIER', 'bills.create'),
('CASHIER', 'bills.settle'),
('CASHIER', 'bills.split'),
('CASHIER', 'bills.discount.apply'),
('CASHIER', 'shift.open'),
('CASHIER', 'shift.close'),
('CASHIER', 'menu.view'),
('WAITER', 'orders.read'),
('WAITER', 'orders.create'),
('WAITER', 'orders.edit'),
('WAITER', 'orders.move_table'),
('WAITER', 'orders.merge'),
('WAITER', 'kot.print'),
('WAITER', 'menu.view'),
('CHEF', 'kds.view'),
('CHEF', 'kds.bump'),
('CHEF', 'kds.recall'),
('CHEF', 'kds.hold'),
('ACCOUNTANT', 'reports.view.sales'),
('ACCOUNTANT', 'reports.view.financial'),
('ACCOUNTANT', 'reports.view.gst'),
('ACCOUNTANT', 'reports.view.staff_performance'),
('ACCOUNTANT', 'reports.view.kds_sla'),
('ACCOUNTANT', 'audit.view'),
('INVENTORY_MANAGER', 'inventory.view'),
('INVENTORY_MANAGER', 'inventory.adjust'),
('SUPER_ADMIN', 'orders.read'),
('SUPER_ADMIN', 'orders.create'),
('SUPER_ADMIN', 'orders.edit'),
('SUPER_ADMIN', 'orders.void'),
('SUPER_ADMIN', 'orders.move_table'),
('SUPER_ADMIN', 'orders.merge'),
('SUPER_ADMIN', 'kot.print'),
('SUPER_ADMIN', 'kot.reprint'),
('SUPER_ADMIN', 'bills.create'),
('SUPER_ADMIN', 'bills.settle'),
('SUPER_ADMIN', 'bills.split'),
('SUPER_ADMIN', 'bills.discount.apply'),
('SUPER_ADMIN', 'bills.discount.approve'),
('SUPER_ADMIN', 'bills.void'),
('SUPER_ADMIN', 'bills.day_close'),
('SUPER_ADMIN', 'bills.refund'),
('SUPER_ADMIN', 'shift.open'),
('SUPER_ADMIN', 'shift.close'),
('SUPER_ADMIN', 'menu.view'),
('SUPER_ADMIN', 'menu.edit'),
('SUPER_ADMIN', 'menu.price_edit'),
('SUPER_ADMIN', 'reports.view.sales'),
('SUPER_ADMIN', 'reports.view.financial'),
('SUPER_ADMIN', 'reports.view.gst'),
('SUPER_ADMIN', 'reports.view.staff_performance'),
('SUPER_ADMIN', 'reports.view.kds_sla'),
('SUPER_ADMIN', 'kds.view'),
('SUPER_ADMIN', 'kds.bump'),
('SUPER_ADMIN', 'kds.recall'),
('SUPER_ADMIN', 'kds.hold'),
('SUPER_ADMIN', 'inventory.view'),
('SUPER_ADMIN', 'inventory.adjust'),
('SUPER_ADMIN', 'staff.manage'),
('SUPER_ADMIN', 'roles.manage'),
('SUPER_ADMIN', 'settings.manage'),
('SUPER_ADMIN', 'outlets.manage'),
('SUPER_ADMIN', 'audit.view'),
('SUPER_ADMIN', 'customers.view'),
('SUPER_ADMIN', 'customers.manage')
)
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id" FROM grants g JOIN "roles" r ON r."name" = g.role_name AND ((g.role_name = 'SUPER_ADMIN' AND r."tenantId" IS NULL) OR (g.role_name <> 'SUPER_ADMIN' AND r."tenantId" IS NOT NULL)) JOIN "permissions" p ON p."key" = g.permission_key
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Retire legacy keys after their grants have been copied.
DELETE FROM "role_permissions" rp USING "permissions" p WHERE rp."permissionId" = p."id" AND p."key" IN ('order.create','order.discount','order.void','bill.refund','bill.split','menu.manage','inventory.manage','reports.view','team.manage','customer.manage','kot.update');
DELETE FROM "permissions" WHERE "key" IN ('order.create','order.discount','order.void','bill.refund','bill.split','menu.manage','inventory.manage','reports.view','team.manage','customer.manage','kot.update');

-- Every existing outlet starts with a safe default policy; custom settings are preserved.
INSERT INTO "outlet_settings" ("outletId", "settings", "updatedAt")
SELECT "id", '{"discountApprovalThresholdPct":10,"voidRequiresApproval":false,"slaMinutesPerOrderType":{"DINE_IN":15,"TAKEAWAY":15,"DELIVERY":20},"kdsSoundEnabled":true,"hiddenReports":{}}'::jsonb, CURRENT_TIMESTAMP
FROM "outlets" ON CONFLICT ("outletId") DO NOTHING;
COMMIT;
