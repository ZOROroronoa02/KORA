import { NextResponse } from "next/server";
import { readJsonObject, RequestInputError } from "@/lib/http";
import { isInvitationToken } from "@/lib/domain/staff-invitations";
import { hashToken } from "@/lib/server-auth";
import { isSameOriginRequest } from "@/lib/csrf";
import { RateLimitUnavailableError, isRateLimited } from "@/lib/rate-limit";
import { rootPrisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Cross-origin request denied." }, { status: 403 });
  try {
    const body = await readJsonObject(request);
    const token = body.token;
    if (!isInvitationToken(token)) return NextResponse.json({ error: "This invitation is invalid or has expired." }, { status: 404, headers: { "cache-control": "no-store" } });
    const throttle = await isRateLimited(request, "staff-invitation-resolve", 30, 3600, token);
    if (throttle.limited) return NextResponse.json({ error: "Too many invitation attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(throttle.retryAfter), "cache-control": "no-store" } });
    const now = new Date();
    const invitation = await rootPrisma.staffInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        email: true, expiresAt: true, acceptedAt: true, revokedAt: true,
        tenant: { select: { name: true } }, outlet: { select: { name: true } }, role: { select: { name: true } },
      },
    });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
      return NextResponse.json({ error: "This invitation is invalid or has expired." }, { status: 404, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ invitation: { email: invitation.email, tenantName: invitation.tenant.name, outletName: invitation.outlet.name, roleName: invitation.role.name, expiresAt: invitation.expiresAt } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof RateLimitUnavailableError) return NextResponse.json({ error: "Invitation service is temporarily unavailable." }, { status: 503 });
    return NextResponse.json({ error: "Could not verify this invitation." }, { status: 500 });
  }
}
