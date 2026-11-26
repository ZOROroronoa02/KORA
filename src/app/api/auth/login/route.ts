import { compare } from "bcryptjs";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { accessTokenSeconds, createAccessToken, hashToken, newRefreshToken, refreshCookie } from "@/lib/server-auth";
import { isRateLimited, RateLimitUnavailableError } from "@/lib/rate-limit";
import { passwordFitsBcrypt } from "@/lib/password-policy";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    const tenantSlug = typeof body.tenantSlug === "string" ? body.tenantSlug.trim().toLowerCase() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const throttle = await isRateLimited(request, "login", 10, 900, tenantSlug && email ? `${tenantSlug}:${email}` : undefined);
    if (throttle.limited) return NextResponse.json({ error: "Too many sign-in attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": String(throttle.retryAfter) } });
    if (!tenantSlug || !email || !password || !passwordFitsBcrypt(password)) return NextResponse.json({ error: "Invalid restaurant, email, or password." }, { status: 401 });
    const user = await prisma.user.findFirst({ where: { tenant: { slug: tenantSlug }, email, active: true }, include: { tenant: true, assignments: { include: { outlet: true, role: true } } } });
    if (!user || !(await compare(password, user.passwordHash))) return NextResponse.json({ error: "Invalid restaurant, email, or password." }, { status: 401 });
    const accessToken = await createAccessToken(user);
    const refresh = newRefreshToken();
    await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    const response = NextResponse.json({ accessToken, expiresIn: accessTokenSeconds, tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug }, outlets: user.assignments.map((a) => ({ id: a.outlet.id, name: a.outlet.name, role: a.role.name })), user: { id: user.id, name: user.name, email: user.email } });
    response.headers.set("set-cookie", refreshCookie(refresh, 30 * 24 * 60 * 60));
    return response;
  } catch (error) {
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof RateLimitUnavailableError || (error instanceof Error && error.message.includes("JWT_ACCESS_SECRET"))) return NextResponse.json({ error: "Sign-in is temporarily unavailable." }, { status: 503 });
    return NextResponse.json({ error: "Could not sign in." }, { status: 500 });
  }
}
