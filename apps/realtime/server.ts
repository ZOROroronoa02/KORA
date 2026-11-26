import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Server } from "socket.io";
import { prisma } from "../../src/lib/prisma.js";
import { verifyAccessToken } from "../../src/lib/server-auth.js";

type SocketIdentity = { tenantId: string; userId: string; outletId: string; expiresAt: number; permissions: string[] };
type KoraSocketData = { identity?: SocketIdentity };

const originConfig = process.env.KORA_REALTIME_ORIGINS;
const allowedOrigins = (originConfig ?? "http://localhost:3000,http://localhost:3001").split(",").map((origin) => origin.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && (!allowedOrigins.length || allowedOrigins.some((origin) => {
  try { return new URL(origin).protocol !== "https:"; }
  catch { return true; }
}))) throw new Error("KORA_REALTIME_ORIGINS must list exact HTTPS web origins in production");
const server = createServer((request, response) => {
  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ name: "kora-realtime", status: "ok" })); return; }
  response.writeHead(404); response.end("Not found");
});
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true }, transports: ["websocket", "polling"], maxHttpBufferSize: 32 * 1024 });

if (process.env.REDIS_URL) {
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  pubClient.on("error", (error) => console.error("KORA realtime Redis publisher error", error.message));
  subClient.on("error", (error) => console.error("KORA realtime Redis subscriber error", error.message));
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));
}

io.use(async (socket, next) => {
  try {
    const token = typeof socket.handshake.auth.accessToken === "string" ? socket.handshake.auth.accessToken : "";
    const outletId = typeof socket.handshake.auth.outletId === "string" ? socket.handshake.auth.outletId : "";
    if (!token || !outletId) return next(new Error("Authentication and outlet context are required"));
    const claims = await verifyAccessToken(token);
    const user = await prisma.user.findFirst({
      where: { id: claims.userId, tenantId: claims.tenantId, active: true },
      include: { assignments: { where: { outletId, outlet: { tenantId: claims.tenantId } }, include: { outlet: true, role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    const assignments = user?.assignments.filter((assignment) => assignment.outlet.tenantId === claims.tenantId) ?? [];
    if (!user || assignments.length === 0) return next(new Error("Access to this outlet is not allowed"));
    const permissions = [...new Set(assignments.flatMap((assignment) => assignment.role.permissions.map((rp) => rp.permission.key)))].sort();
    socket.data.identity = { tenantId: claims.tenantId, userId: user.id, outletId, expiresAt: claims.expiresAt, permissions };
    next();
  } catch { next(new Error("Invalid or expired access token")); }
});

io.on("connection", (socket) => {
  const identity = (socket.data as KoraSocketData).identity!;
  socket.join(`tenant:${identity.tenantId}:outlet:${identity.outletId}`);
  socket.emit("kora:ready", { outletId: identity.outletId });

  const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, identity.expiresAt - Date.now()));
  let checking = false;
  const authorizationTimer = setInterval(async () => {
    if (checking || !socket.connected) return;
    checking = true;
    try {
      const assignments = await prisma.userOutletRole.findMany({
        where: { userId: identity.userId, outletId: identity.outletId, user: { tenantId: identity.tenantId, active: true }, outlet: { tenantId: identity.tenantId } },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      });
      if (!assignments.length) { socket.disconnect(true); return; }
      const current = [...new Set(assignments.flatMap((assignment) => assignment.role.permissions.map((rp) => rp.permission.key)))].sort();
      if (current.length !== identity.permissions.length || current.some((permission, index) => permission !== identity.permissions[index])) {
        socket.disconnect(true);
      }
    } catch {
      socket.disconnect(true);
    } finally { checking = false; }
  }, 30_000);

  socket.on("disconnect", () => { clearTimeout(expiryTimer); clearInterval(authorizationTimer); });
  socket.on("kot:ack", (payload: { kotId?: unknown }) => {
    if (!identity.permissions.includes("kot.update") || typeof payload?.kotId !== "string" || payload.kotId.length > 80) return;
    socket.emit("kora:action-required", { action: "kot.update", kotId: payload.kotId });
  });
});

const port = Number(process.env.REALTIME_PORT ?? 4000);
server.listen(port, () => console.log(`KORA Socket.io service listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { io.close(() => process.exit(0)); });
