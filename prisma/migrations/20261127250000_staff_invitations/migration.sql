-- One-time, owner-issued staff invitations reserve tenant user seats.
-- Reversal: DROP TRIGGER kora_staff_invitation_guard ON public.staff_invitations;
-- DROP FUNCTION public.kora_assert_staff_invitation_ownership();
-- DROP TABLE public.staff_invitations;

CREATE TABLE "staff_invitations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "outletId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_invitations_accepted_revoked_check" CHECK (NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)),
  CONSTRAINT "staff_invitations_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "staff_invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_invitations_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_invitations_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_invitations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "staff_invitations_tokenHash_key" ON "staff_invitations"("tokenHash");
CREATE INDEX "staff_invitations_tenantId_email_acceptedAt_revokedAt_idx" ON "staff_invitations"("tenantId", "email", "acceptedAt", "revokedAt");
CREATE INDEX "staff_invitations_tenantId_outletId_createdAt_idx" ON "staff_invitations"("tenantId", "outletId", "createdAt");
CREATE INDEX "staff_invitations_expiresAt_acceptedAt_revokedAt_idx" ON "staff_invitations"("expiresAt", "acceptedAt", "revokedAt");

CREATE OR REPLACE FUNCTION public.kora_assert_staff_invitation_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  outlet_tenant TEXT;
  role_tenant TEXT;
  role_outlet TEXT;
  creator_tenant TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR
    NEW."outletId" IS DISTINCT FROM OLD."outletId" OR
    NEW."email" IS DISTINCT FROM OLD."email" OR
    NEW."roleId" IS DISTINCT FROM OLD."roleId" OR
    NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR
    NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" OR
    NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  ) THEN
    RAISE EXCEPTION 'KORA invitation identity fields are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'kora_staff_invitation_ownership_guard';
  END IF;

  SELECT "tenantId" INTO outlet_tenant FROM public.outlets WHERE id = NEW."outletId";
  SELECT "tenantId", "outletId" INTO role_tenant, role_outlet FROM public.roles WHERE id = NEW."roleId";
  SELECT "tenantId" INTO creator_tenant FROM public.users WHERE id = NEW."createdByUserId";
  IF outlet_tenant IS DISTINCT FROM NEW."tenantId" OR
     role_tenant IS DISTINCT FROM NEW."tenantId" OR
     (role_outlet IS NOT NULL AND role_outlet IS DISTINCT FROM NEW."outletId") OR
     creator_tenant IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'KORA staff invitation tenant/outlet ownership violation'
      USING ERRCODE = '23514', CONSTRAINT = 'kora_staff_invitation_ownership_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER kora_staff_invitation_guard
BEFORE INSERT OR UPDATE ON public.staff_invitations
FOR EACH ROW EXECUTE FUNCTION public.kora_assert_staff_invitation_ownership();
