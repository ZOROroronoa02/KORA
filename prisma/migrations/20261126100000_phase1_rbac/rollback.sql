-- Reversibility note: Prisma Migrate has no automatic down operation.
-- Use this file only after taking a database backup and stopping KORA writers.
-- Restore legacy role names/permission grants from the backup before applying structural rollback.
-- The forward migration intentionally retires legacy permission rows after copying grants.
BEGIN;
DELETE FROM "roles" WHERE "id" = 'kora-system-super-admin';
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_approvalUserId_fkey";
DROP TABLE IF EXISTS "outlet_settings";
DROP TABLE IF EXISTS "user_platform_roles";
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_outletId_fkey";
DROP INDEX IF EXISTS "roles_outletId_idx";
DROP INDEX IF EXISTS "user_platform_roles_roleId_idx";
ALTER TABLE "roles" DROP COLUMN IF EXISTS "outletId";
ALTER TABLE "roles" DROP COLUMN IF EXISTS "description";
ALTER TABLE "roles" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "users" DROP COLUMN IF EXISTS "approvalPinHash";
COMMIT;
