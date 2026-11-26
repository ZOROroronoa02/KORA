import { Emitter } from "@socket.io/redis-emitter";
import { createClient, type RedisClientType } from "redis";
import { realtimeRoomsForEvent } from "@/lib/realtime-permissions";

let publisher: RedisClientType | undefined;
let emitter: Emitter | undefined;
let ready: Promise<void> | undefined;

async function getEmitter() {
  if (!process.env.REDIS_URL) return null;
  if (!publisher) {
    publisher = createClient({ url: process.env.REDIS_URL });
    publisher.on("error", () => undefined);
    ready = publisher.connect().then(() => { emitter = new Emitter(publisher!); });
  }
  await ready;
  return emitter ?? null;
}

export async function publishOutletEvent(tenantId: string, outletId: string, event: string, payload: unknown) {
  const rooms = realtimeRoomsForEvent(tenantId, outletId, event);
  if (!rooms.length) return;
  try {
    const target = await getEmitter();
    if (!target) return;
    target.of("/").to(rooms).emit(event, payload);
  } catch (error) {
    console.error("KORA realtime publish failed", error instanceof Error ? error.message : "unknown error");
  }
}
