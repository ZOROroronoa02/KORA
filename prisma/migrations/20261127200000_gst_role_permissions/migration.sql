-- Add GST configuration and item-tax permissions to existing system owners.
-- New tenants receive the same grants through ensureTenantSystemRoles().
INSERT INTO "permissions" ("id", "key", "description") VALUES
  ('kora-permission-menu-tax-edit-v1', 'menu.tax_edit', 'Change menu item GST rates'),
  ('kora-permission-tax-profile-manage-v1', 'tax.profile.manage', 'Manage tenant GST registration and tax profile')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" AS r
JOIN "permissions" AS p ON p."key" IN ('menu.tax_edit', 'tax.profile.manage')
WHERE r."isSystem" = true AND r."name" = 'OWNER' AND r."tenantId" IS NOT NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Down migration (manual/reversible): delete role_permissions for OWNER roles for
-- the two keys, then delete these permission rows. This intentionally removes only
-- grants added by this migration; review owner customizations before rollback.
