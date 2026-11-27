import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { occupiedUserSeats, normalizeInvitationEmail } from "@/lib/domain/staff-invitations";
import { planLimit } from "@/lib/domain/plan-limits";
import { hashToken, invalidateOutletPermissionCache, requirePermission, withTenantScope } from "@/lib/server-auth";
import { RateLimitUnavailableError, isRateLimited } from "@/lib/rate-limit";
import { prisma, rootPrisma } from "@/lib/prisma";

export const runtime = "nodejs";

class InvitationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function failure(error: unknown) {
  if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
  if (error instanceof InvitationError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof RateLimitUnavailableError) return NextResponse.json({ error: "Invitation service is temporarily unavailable." }, { status: 503 });
  if (typeof error === "object" && error && "code" in error && error.code === "P2002") return NextResponse.json({ error: "An invitation for this email already exists. Revoke it before issuing another." }, { status: 409 });
  return NextResponse.json({ error: "Could not process the staff invitation." }, { status: 500 });
}

function invitationOrigin(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.KORA_APP_ORIGIN) throw new InvitationError("The application origin is not configured.", 503);
    try {
      const configured = new URL(process.env.KORA_APP_ORIGIN);
      if (configured.protocol !== "https:") throw new InvitationError("The application origin must use HTTPS.", 503);
      return configured.origin;
    } catch (error) {
      if (error instanceof InvitationError) throw error;
      throw new InvitationError("The application origin is invalid.", 503);
    }
  }
  return request.nextUrl.origin;
}

async function GETHandler(request: NextRequest) {
  const outletId = request.nextUrl.searchParams.get("outletId") ?? "";
  const access = await requirePermission(request, outletId, "roles.manage");
  if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
  const now = new Date();
  const invitations = await prisma.staffInvitation.findMany({
    where: { tenantId: access.tenantId, outletId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, email: true, expiresAt: true, createdAt: true, role: { select: { id: true, name: true } }, createdBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ invitations }, { headers: { "cache-control": "no-store" } });
}

async function POSTHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const roleId = typeof body.roleId === "string" ? body.roleId.trim() : "";
    const email = typeof body.email === "string" ? normalizeInvitationEmail(body.email) : "";
    const access = await requirePermission(request, outletId, "roles.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (!outletId || !roleId || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "Provide a valid staff email, role, and outlet." }, { status: 400 });
    const origin = invitationOrigin(request);
    const throttle = await isRateLimited(request, "staff-invitation-create", 20, 3600, `${access.tenantId}:${email}`);
    if (throttle.limited) return NextResponse.json({ error: "Too many invitation attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(throttle.retryAfter) } });

    const now = new Date();
    const rawToken = randomBytes(32).toString("base64url");
    const saved = await rootPrisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "tenants" WHERE "id" = ${access.tenantId} FOR UPDATE`;
      const [tenant, outlet, role, user] = await Promise.all([
        tx.tenant.findUnique({ where: { id: access.tenantId }, select: { plan: true } }),
        tx.outlet.findFirst({ where: { id: outletId, tenantId: access.tenantId }, select: { id: true } }),
        tx.role.findFirst({ where: { id: roleId, tenantId: access.tenantId, OR: [{ outletId: null }, { outletId }] }, select: { id: true, name: true, isSystem: true } }),
        tx.user.findUnique({ where: { tenantId_email: { tenantId: access.tenantId, email } }, select: { id: true, active: true } }),
      ]);
      if (!tenant || !outlet || !role || (role.isSystem && role.name === "SUPER_ADMIN")) throw new InvitationError("The outlet or role is unavailable in this tenant.", 404);
      if (user && !user.active) throw new InvitationError("This staff account is inactive. Reactivate it before assigning outlet access.", 409);

      if (user) {
        const existing = await tx.userOutletRole.findUnique({ where: { userId_outletId_roleId: { userId: user.id, outletId, roleId } }, select: { userId: true } });
        if (existing) throw new InvitationError("This staff member already has the selected outlet role.", 409);
        await tx.userOutletRole.create({ data: { userId: user.id, outletId, roleId } });
        await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "STAFF_ACCESS_ASSIGNED", entityType: "User", entityId: user.id, after: { email, role: role.name } } });
        return { assigned: true as const, userId: user.id, roleName: role.name };
      }

      const [activeUsers, pending] = await Promise.all([
        tx.user.findMany({ where: { tenantId: access.tenantId, active: true }, select: { email: true } }),
        tx.staffInvitation.findMany({ where: { tenantId: access.tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { email: true, expiresAt: true, acceptedAt: true, revokedAt: true } }),
      ]);
      const currentSeats = occupiedUserSeats(activeUsers.map((item) => item.email), pending, now);
      const requestedSeats = occupiedUserSeats(activeUsers.map((item) => item.email), [...pending, { email, expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000), acceptedAt: null, revokedAt: null }], now);
      if (requestedSeats > planLimit(tenant.plan, "users") && requestedSeats > currentSeats) {
        throw new InvitationError(`The ${tenant.plan} plan allows ${planLimit(tenant.plan, "users")} active or reserved user seats.`, 409);
      }

      await tx.staffInvitation.updateMany({ where: { tenantId: access.tenantId, outletId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const invitation = await tx.staffInvitation.create({ data: {
        tenantId: access.tenantId, outletId, email, roleId, tokenHash: hashToken(rawToken), createdByUserId: access.user.id,
        expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      }, select: { id: true, expiresAt: true } });
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "STAFF_INVITATION_CREATED", entityType: "StaffInvitation", entityId: invitation.id, after: { email, role: role.name, expiresAt: invitation.expiresAt.toISOString() } } });
      return { assigned: false as const, invitationId: invitation.id, expiresAt: invitation.expiresAt };
    }, { maxWait: 5000, timeout: 15000 });

    if (saved.assigned) {
      await invalidateOutletPermissionCache(outletId, [saved.userId]);
      return NextResponse.json({ assigned: true, role: saved.roleName }, { status: 200 });
    }
    const invite = new URL("/join", origin);
    invite.hash = rawToken;
    return NextResponse.json({ assigned: false, invitation: { id: saved.invitationId, email, expiresAt: saved.expiresAt, url: invite.toString() } }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return failure(error); }
}

async function DELETEHandler(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    const outletId = typeof body.outletId === "string" ? body.outletId.trim() : "";
    const invitationId = typeof body.invitationId === "string" ? body.invitationId.trim() : "";
    const access = await requirePermission(request, outletId, "roles.manage");
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    if (!invitationId) return NextResponse.json({ error: "Select an invitation to revoke." }, { status: 400 });
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const invitation = await tx.staffInvitation.findFirst({ where: { id: invitationId, tenantId: access.tenantId, outletId, acceptedAt: null, revokedAt: null }, select: { id: true, email: true, role: { select: { name: true } } } });
      if (!invitation) throw new InvitationError("Pending invitation not found or already used.", 404);
      const revoked = await tx.staffInvitation.updateMany({ where: { id: invitationId, tenantId: access.tenantId, outletId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      if (revoked.count !== 1) throw new InvitationError("Invitation has already been accepted or revoked.", 409);
      await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: "STAFF_INVITATION_REVOKED", entityType: "StaffInvitation", entityId: invitation.id, before: { email: invitation.email, role: invitation.role.name }, after: { revokedAt: now.toISOString() } } });
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return failure(error); }
}

export const GET = withTenantScope(GETHandler);
export const POST = withTenantScope(POSTHandler);
export const DELETE = withTenantScope(DELETEHandler);
