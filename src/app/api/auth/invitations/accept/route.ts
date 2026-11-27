import { hash } from "bcryptjs";
import { NextResponse } from "next/server";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { isInvitationToken, normalizeInvitationEmail, occupiedUserSeats } from "@/lib/domain/staff-invitations";
import { exceedsPlanLimit, planLimit } from "@/lib/domain/plan-limits";
import { isSameOriginRequest } from "@/lib/csrf";
import { RateLimitUnavailableError, isRateLimited } from "@/lib/rate-limit";
import { accessTokenSeconds, createAccessToken, hashToken, newRefreshToken, refreshCookie } from "@/lib/server-auth";
import { passwordMeetsRegistrationPolicy } from "@/lib/password-policy";
import { rootPrisma } from "@/lib/prisma";

export const runtime = "nodejs";

class AcceptanceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Cross-origin request denied." }, { status: 403 });
  try {
    const body = await readJsonObject(request);
    const token = body.token;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!isInvitationToken(token)) return NextResponse.json({ error: "This invitation is invalid or has expired." }, { status: 404 });
    const throttle = await isRateLimited(request, "staff-invitation-accept", 10, 3600, token);
    if (throttle.limited) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(throttle.retryAfter) } });
    if (name.length < 2 || name.length > 100 || !passwordMeetsRegistrationPolicy(password) || phone.length > 32) {
      return NextResponse.json({ error: "Provide your name and a password of 12–72 UTF-8 bytes. Phone is optional." }, { status: 400 });
    }
    const tokenHash = hashToken(token);
    const now = new Date();
    const candidate = await rootPrisma.staffInvitation.findUnique({ where: { tokenHash }, select: { tenantId: true, email: true, acceptedAt: true, revokedAt: true, expiresAt: true } });
    if (!candidate || candidate.acceptedAt || candidate.revokedAt || candidate.expiresAt <= now) {
      return NextResponse.json({ error: "This invitation is invalid or has expired." }, { status: 404 });
    }
    const passwordHash = await hash(password, 12);
    const refresh = newRefreshToken();
    const created = await rootPrisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "tenants" WHERE "id" = ${candidate.tenantId} FOR UPDATE`;
      const invitation = await tx.staffInvitation.findUnique({
        where: { tokenHash },
        include: { tenant: { select: { id: true, plan: true, slug: true, name: true } }, outlet: { select: { id: true, name: true } }, role: { select: { id: true, name: true } } },
      });
      const acceptedAt = new Date();
      if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= acceptedAt) throw new AcceptanceError("This invitation is invalid or has expired.", 404);
      const existing = await tx.user.findUnique({ where: { tenantId_email: { tenantId: invitation.tenantId, email: invitation.email } }, select: { id: true, active: true } });
      if (existing) throw new AcceptanceError("This email already has an account. Ask the restaurant owner to assign outlet access from Team settings.", 409);

      const [activeUsers, pending] = await Promise.all([
        tx.user.findMany({ where: { tenantId: invitation.tenantId, active: true }, select: { email: true } }),
        tx.staffInvitation.findMany({ where: { tenantId: invitation.tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: acceptedAt } }, select: { email: true, expiresAt: true, acceptedAt: true, revokedAt: true } }),
      ]);
      const seats = occupiedUserSeats(activeUsers.map((user) => user.email), pending, acceptedAt);
      if (exceedsPlanLimit(invitation.tenant.plan, "users", seats - 1)) {
        throw new AcceptanceError(`The ${invitation.tenant.plan} plan currently allows ${planLimit(invitation.tenant.plan, "users")} user seats. Ask the owner to review plan capacity.`, 409);
      }

      const user = await tx.user.create({ data: { tenantId: invitation.tenantId, name, email: normalizeInvitationEmail(invitation.email), phone: phone || null, passwordHash } });
      await tx.userOutletRole.create({ data: { userId: user.id, outletId: invitation.outletId, roleId: invitation.roleId } });
      const claimed = await tx.staffInvitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: acceptedAt } }, data: { acceptedAt } });
      if (claimed.count !== 1) throw new AcceptanceError("This invitation has already been used or has expired.", 409);
      await tx.auditLog.create({ data: { tenantId: invitation.tenantId, outletId: invitation.outletId, userId: user.id, action: "STAFF_INVITATION_ACCEPTED", entityType: "User", entityId: user.id, after: { email: user.email, role: invitation.role.name, invitationId: invitation.id, invitedByUserId: invitation.createdByUserId } } });
      const accessToken = await createAccessToken(user);
      await tx.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refresh), expiresAt: new Date(acceptedAt.getTime() + 30 * 24 * 60 * 60 * 1000) } });
      return { user, tenant: invitation.tenant, outlet: invitation.outlet, role: invitation.role, accessToken };
    }, { maxWait: 5000, timeout: 15000 });

    const response = NextResponse.json({
      accessToken: created.accessToken,
      expiresIn: accessTokenSeconds,
      tenant: { id: created.tenant.id, name: created.tenant.name, slug: created.tenant.slug },
      outlets: [{ id: created.outlet.id, name: created.outlet.name, role: created.role.name }],
      user: { id: created.user.id, name: created.user.name, email: created.user.email },
    }, { status: 201, headers: { "cache-control": "no-store" } });
    response.headers.set("set-cookie", refreshCookie(refresh, 30 * 24 * 60 * 60));
    return response;
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof AcceptanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof RateLimitUnavailableError || (error instanceof Error && error.message.includes("JWT_ACCESS_SECRET"))) return NextResponse.json({ error: "Invitation service is temporarily unavailable." }, { status: 503 });
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return NextResponse.json({ error: "This invitation is no longer available." }, { status: 409 });
    return NextResponse.json({ error: "Could not accept this invitation." }, { status: 500 });
  }
}
