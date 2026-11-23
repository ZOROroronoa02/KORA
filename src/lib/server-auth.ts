import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

const COOKIE_NAME = "kora_refresh";
const accessTtl = "15m";

function signingKey() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_ACCESS_SECRET must contain at least 32 characters");
  return new TextEncoder().encode(secret);
}

export async function createAccessToken(user: { id: string; tenantId: string }) {
  return new SignJWT({ tenantId: user.tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(accessTtl)
    .sign(signingKey());
}

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, signingKey());
  if (typeof payload.sub !== "string" || typeof payload.tenantId !== "string") throw new Error("Invalid access token");
  return { userId: payload.sub, tenantId: payload.tenantId };
}

export function newRefreshToken() { return randomBytes(48).toString("base64url"); }
export function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function refreshCookie(token: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export function clearRefreshCookie() { return refreshCookie("", 0); }
export function readRefreshCookie(request: Request) {
  const raw = request.headers.get("cookie") ?? "";
  return raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? "";
}

export async function getUserFromRequest(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(token);
    const user = await prisma.user.findFirst({ where: { id: claims.userId, tenantId: claims.tenantId, active: true }, select: { id: true, tenantId: true, name: true, email: true } });
    return user;
  } catch { return null; }
}

export async function authorizeOutlet(request: NextRequest, outletId: string, permission: string) {
  const user = await getUserFromRequest(request);
  if (!user) return { error: "Unauthenticated" as const };
  const assignments = await prisma.userOutletRole.findMany({
    where: { userId: user.id, outletId, outlet: { tenantId: user.tenantId } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const allowed = assignments.some((assignment) => assignment.role.permissions.some((rp) => rp.permission.key === permission));
  if (!allowed) return { error: "Forbidden" as const };
  return { user, tenantId: user.tenantId };
}

export const accessTokenSeconds = 15 * 60;
