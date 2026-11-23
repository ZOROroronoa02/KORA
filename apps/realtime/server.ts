import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Server } from "socket.io";
import { prisma } from "../../src/lib/prisma.js";
import { verifyAccessToken } from "../../src/lib/server-auth.js";

type SocketIdentity = { tenantId: string; userId: string; outletId: string; permissions: string[] };
type KoraSocketData = { identity?: SocketIdentity };

const allowedOrigins = (process.env.KORA_REALTIME_ORIGINS ?? "http://localhost:3000,http://localhost:3001").split(",").map((origin) => origin.trim());
const server = createServer((request, response) => {
  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ name: "kora-realtime", status: "ok" })); return; }
  response.writeHead(404); response.end("Not found");
});
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true }, transports: ["websocket", "polling"] });

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
    const user = await prisma.user.findFirst({ where: { id: claims.userId, tenantId: claims.tenantId, active: true }, include: { assignments: { where: { outletId }, include: { outlet: true, role: { include: { permissions: { include: { permission: true } } } } } } } });
    const assignment = user?.assignments[0];
    if (!user || !assignment || assignment.outlet.tenantId !== claims.tenantId) return next(new Error("Access to this outlet is not allowed"));
    socket.data.identity = { tenantId: claims.tenantId, userId: user.id, outletId, permissions: assignment.role.permissions.map((rp) => rp.permission.key) };
    next();
  } catch { next(new Error("Invalid or expired access token")); }
});

io.on("connection", (socket) => {
  const identity = socket.data.identity!;
  socket.join(`tenant:${identity.tenantId}:outlet:${identity.outletId}`);
  socket.emit("kora:ready", { outletId: identity.outletId });
  socket.on("kot:ack", (payload: { kotId?: unknown }) => {
    if (!identity.permissions.includes("kot.update") || typeof payload?.kotId !== "string") return;
    // Kitchen status is written through the authenticated API so it receives the same audit trail.
    socket.emit("kora:action-required", { action: "kot.update", kotId: payload.kotId });
  });
});

const port = Number(process.env.REALTIME_PORT ?? 4000);
server.listen(port, () => console.log(`KORA Socket.io service listening on :${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { io.close(() => process.exit(0)); });
