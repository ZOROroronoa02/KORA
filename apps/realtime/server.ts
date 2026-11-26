import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Server } from "socket.io";
import nextEnv from "@next/env";
import { prisma } from "../../src/lib/prisma.js";
import { verifyAccessToken } from "../../src/lib/server-auth.js";
import { realtimePermissionRoom } from "../../src/lib/realtime-permissions.js";

nextEnv.loadEnvConfig(process.cwd());

type SocketIdentity = { tenantId: string; userTenantId: string; userId: string; outletId: string; expiresAt: number; permissions: string[] };
type KoraSocketData = { identity?: SocketIdentity };

const originConfig = process.env.KORA_REALTIME_ORIGINS;
const allowedOrigins = (originConfig ?? "http://localhost:3000,http://localhost:3001").split(",").map((origin) => origin.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && (!allowedOrigins.length || allowedOrigins.some((origin) => {
  try { return new URL(origin).protocol !== "https:"; }
  catch { return true; }
}))) throw new Error("KORA_REALTIME_ORIGINS must list exact HTTPS web origins in production");
if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required in production for shared realtime fan-out");
}

let redisPubClient: ReturnType<typeof createClient> | undefined;
let redisSubClient: ReturnType<typeof createClient> | undefined;
const server = createServer(async (request, response) => {
  if (request.url === "/health" || request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "kora-realtime", status: "alive" }));
    return;
  }
  if (request.url === "/health/ready") {
    let databaseReady = false;
    try { await prisma.$queryRaw`SELECT 1`; databaseReady = true; }
    catch { databaseReady = false; }
    const redisState = process.env.REDIS_URL
      ? (redisPubClient?.isReady && redisSubClient?.isReady ? "ready" : "unavailable")
      : process.env.NODE_ENV === "production" ? "required" : "not_configured";
    const ready = databaseReady && (redisState === "ready" || redisState === "not_configured");
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "kora-realtime", status: ready ? "ready" : "not_ready", database: databaseReady, redis: redisState }));
    return;
  }
  response.writeHead(404); response.end("Not found");
});
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true }, transports: ["websocket", "polling"], maxHttpBufferSize: 32 * 1024 });

if (process.env.REDIS_URL) {
  redisPubClient = createClient({ url: process.env.REDIS_URL });
  redisSubClient = redisPubClient.duplicate();
  redisPubClient.on("error", (error) => console.error("KORA realtime Redis publisher error", error.message));
  redisSubClient.on("error", (error) => console.error("KORA realtime Redis subscriber error", error.message));
  await Promise.all([redisPubClient.connect(), redisSubClient.connect()]);
  io.adapter(createAdapter(redisPubClient, redisSubClient));
}

async function resolveSocketAccess(userId: string, userTenantId: string, outletId: string) {
  const outlet = await prisma.outlet.findUnique({ where: { id: outletId }, select: { id: true, tenantId: true } });
  if (!outlet) return null;
  const [user, platformAssignments, assignments] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, tenantId: userTenantId, active: true }, select: { id: true } }),
    prisma.userPlatformRole.findMany({
      where: { userId, role: { name: "SUPER_ADMIN", isSystem: true, tenantId: null } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }),
    prisma.userOutletRole.findMany({
      where: { userId, outletId, user: { tenantId: userTenantId, active: true }, outlet: { tenantId: outlet.tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }),
  ]);
  if (!user || (outlet.tenantId !== userTenantId && platformAssignments.length === 0)) return null;
  const outletPermissions = assignments
    .filter((assignment) => assignment.role.tenantId === outlet.tenantId && (!assignment.role.outletId || assignment.role.outletId === outletId))
    .flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key));
  const platformPermissions = platformAssignments.flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key));
  return { tenantId: outlet.tenantId, permissions: [...new Set([...outletPermissions, ...platformPermissions])].sort() };
}

io.use(async (socket, next) => {
  try {
    const token = typeof socket.handshake.auth.accessToken === "string" ? socket.handshake.auth.accessToken : "";
    const outletId = typeof socket.handshake.auth.outletId === "string" ? socket.handshake.auth.outletId : "";
    if (!token || !outletId) return next(new Error("Authentication and outlet context are required"));
    const claims = await verifyAccessToken(token);
    const access = await resolveSocketAccess(claims.userId, claims.tenantId, outletId);
    if (!access) return next(new Error("Access to this outlet is not allowed"));
    socket.data.identity = { tenantId: access.tenantId, userTenantId: claims.tenantId, userId: claims.userId, outletId, expiresAt: claims.expiresAt, permissions: access.permissions } satisfies SocketIdentity;
    next();
  } catch { next(new Error("Invalid or expired access token")); }
});

io.on("connection", (socket) => {
  const identity = (socket.data as KoraSocketData).identity!;
  for (const permission of identity.permissions) socket.join(realtimePermissionRoom(identity.tenantId, identity.outletId, permission));
  socket.emit("kora:ready", { outletId: identity.outletId });
  socket.emit("connection:outlet-joined", { outletId: identity.outletId, serverTimestamp: new Date().toISOString() });

  const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, identity.expiresAt - Date.now()));
  let checking = false;
  const authorizationTimer = setInterval(async () => {
    if (checking || !socket.connected) return;
    checking = true;
    try {
      const currentAccess = await resolveSocketAccess(identity.userId, identity.userTenantId, identity.outletId);
      if (!currentAccess || currentAccess.tenantId !== identity.tenantId || currentAccess.permissions.length !== identity.permissions.length || currentAccess.permissions.some((permission, index) => permission !== identity.permissions[index])) {
        socket.disconnect(true);
      }
    } catch {
      socket.disconnect(true);
    } finally { checking = false; }
  }, 30_000);

  socket.on("disconnect", () => { clearTimeout(expiryTimer); clearInterval(authorizationTimer); });
  socket.on("kot:ack", (payload: { kotId?: unknown }) => {
    if (!identity.permissions.includes("kds.bump") || typeof payload?.kotId !== "string" || payload.kotId.length > 80) return;
    socket.emit("kora:action-required", { action: "kds.bump", kotId: payload.kotId });
  });
});

const port = Number(process.env.REALTIME_PORT ?? 4000);
server.listen(port, () => console.log(`KORA Socket.io service listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { io.close(() => process.exit(0)); });
