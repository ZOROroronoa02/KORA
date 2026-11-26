import { createHash, randomBytes } from "node:crypto";
import { compare } from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";
import { createClient, type RedisClientType } from "redis";
import { prisma } from "@/lib/prisma";
import { accessTokenSigningKey } from "@/lib/jwt-secret";

const COOKIE_NAME = "kora_refresh";
const accessTtl = "15m";

function signingKey() {
  return accessTokenSigningKey(process.env.JWT_ACCESS_SECRET);
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
  if (typeof payload.sub !== "string" || typeof payload.tenantId !== "string" || typeof payload.exp !== "number") throw new Error("Invalid access token");
  return { userId: payload.sub, tenantId: payload.tenantId, expiresAt: payload.exp * 1000 };
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

type Authorization = { user: NonNullable<Awaited<ReturnType<typeof getUserFromRequest>>>; tenantId: string; permissions: string[] };
type AuthorizationResult = Authorization | { error: "Unauthenticated" | "Forbidden" };
type CachedPermissions = { permissions: string[]; tenantId: string; expiresAt: number };
const permissionMemory = new Map<string, CachedPermissions>();
let permissionRedis: RedisClientType | null = null;
let permissionRedisConnect: Promise<RedisClientType | null> | null = null;
const permissionCacheTtlSeconds = 30;

async function redisForAuthorization() {
  if (!process.env.REDIS_URL) return null;
  if (!permissionRedisConnect) {
    permissionRedis = createClient({ url: process.env.REDIS_URL });
    permissionRedis.on("error", () => undefined);
    permissionRedisConnect = permissionRedis.connect().then(() => permissionRedis).catch(() => {
      permissionRedis = null;
      permissionRedisConnect = null;
      return null;
    });
  }
  return permissionRedisConnect;
}

function permissionCacheKey(userId: string, outletId: string) {
  return `kora:authz:v1:${userId}:${outletId}`;
}

async function outletPermissions(userId: string, tenantId: string, outletId: string) {
  const key = permissionCacheKey(userId, outletId);
  const shared = await redisForAuthorization();
  if (shared) {
    const value = await shared.get(key).catch(() => null);
    if (value) {
      try {
        const cached = JSON.parse(value) as { permissions: string[]; tenantId: string };
        if (Array.isArray(cached.permissions) && typeof cached.tenantId === "string") return { permissions: cached.permissions, tenantId: cached.tenantId };
      } catch { /* Ignore malformed cache entries and resolve from PostgreSQL. */ }
    }
  } else {
    const cached = permissionMemory.get(key);
    if (cached && cached.expiresAt > Date.now()) return { permissions: cached.permissions, tenantId: cached.tenantId };
    permissionMemory.delete(key);
  }

  const outlet = await prisma.outlet.findFirst({ where: { id: outletId }, select: { tenantId: true } });
  if (!outlet) return null;
  const platformAssignments = await prisma.userPlatformRole.findMany({
    where: { userId, role: { name: "SUPER_ADMIN", isSystem: true, tenantId: null } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const assignedRoles = await prisma.userOutletRole.findMany({
    where: { userId, outletId, user: { tenantId, active: true }, outlet: { tenantId } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const platformPermissions = platformAssignments.flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key));
  const outletRolePermissions = assignedRoles
    .filter((assignment) => assignment.role.tenantId === tenantId && (!assignment.role.outletId || assignment.role.outletId === outletId))
    .flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key));
  const permissions = [...new Set([...platformPermissions, ...outletRolePermissions])].sort();
  if (outlet.tenantId !== tenantId && platformAssignments.length === 0) return null;
  const serialized = JSON.stringify({ tenantId: outlet.tenantId, permissions });
  if (shared) await shared.set(key, serialized, { EX: permissionCacheTtlSeconds }).catch(() => undefined);
  else permissionMemory.set(key, { permissions, tenantId: outlet.tenantId, expiresAt: Date.now() + permissionCacheTtlSeconds * 1000 });
  return { permissions, tenantId: outlet.tenantId };
}

export async function invalidateOutletPermissionCache(outletId: string, userIds?: string[]) {
  const targetUsers = userIds ?? (await prisma.userOutletRole.findMany({ where: { outletId }, select: { userId: true } })).map((assignment) => assignment.userId);
  const keys = targetUsers.map((userId) => permissionCacheKey(userId, outletId));
  for (const key of keys) permissionMemory.delete(key);
  const shared = await redisForAuthorization();
  if (shared && keys.length) await shared.del(keys).catch(() => undefined);
}

/** Re-resolves authorization from PostgreSQL/Redis; JWT role claims are never trusted. */
export async function requirePermission(request: NextRequest, outletId: string, permission: string): Promise<AuthorizationResult> {
  const user = await getUserFromRequest(request);
  if (!user) return { error: "Unauthenticated" as const };
  const access = await outletPermissions(user.id, user.tenantId, outletId);
  if (!access) return { error: "Forbidden" as const };
  const allowed = access.permissions.includes(permission);
  if (!allowed) return { error: "Forbidden" as const };
  return { user, tenantId: access.tenantId, permissions: access.permissions };
}

/** Kept as an internal compatibility alias while route handlers migrate to requirePermission. */
export const authorizeOutlet = requirePermission;

export async function authorizeAnyOutletPermission(request: NextRequest, outletId: string, permissions: string[]): Promise<AuthorizationResult> {
  const user = await getUserFromRequest(request);
  if (!user) return { error: "Unauthenticated" as const };
  const access = await outletPermissions(user.id, user.tenantId, outletId);
  if (!access) return { error: "Forbidden" as const };
  if (!permissions.some((permission) => access.permissions.includes(permission))) return { error: "Forbidden" as const };
  return { user, tenantId: access.tenantId, permissions: access.permissions };
}

/** Approves a sensitive action using a different active manager's personal hashed PIN. */
export async function verifyManagerApprovalPin(input: { outletId: string; pin: string; actorUserId: string; permission: string }) {
  if (!/^\d{4,8}$/.test(input.pin)) return null;
  const candidates = await prisma.userOutletRole.findMany({
    where: { outletId: input.outletId, userId: { not: input.actorUserId }, user: { active: true }, role: { permissions: { some: { permission: { key: input.permission } } } } },
    select: { user: { select: { id: true, tenantId: true, approvalPinHash: true } }, outlet: { select: { tenantId: true } }, role: { select: { tenantId: true, outletId: true, isSystem: true } } },
  });
  for (const candidate of candidates) {
    if (candidate.user.tenantId !== candidate.outlet.tenantId || candidate.role.tenantId !== candidate.outlet.tenantId || (candidate.role.outletId && candidate.role.outletId !== input.outletId)) continue;
    if (candidate.user.approvalPinHash && await compare(input.pin, candidate.user.approvalPinHash)) return candidate.user.id;
  }
  return null;
}

export const accessTokenSeconds = 15 * 60;
