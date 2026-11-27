import { createClient } from "redis";

export type RedisDependencyState = "ready" | "unavailable" | "not_configured" | "required";

export function createReadinessRedisClient(url: string) {
  return createClient({ url, socket: { connectTimeout: 1_000, socketTimeout: 1_000, reconnectStrategy: false } });
}

export async function probeRedis(url: string, timeoutMs = 1_500): Promise<boolean> {
  const client = createReadinessRedisClient(url);
  client.on("error", () => undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect();
        await client.ping();
        return true;
      })(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          client.destroy();
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
    client.destroy();
  }
}

export function redisDependencyState({ configured, healthy, production }: { configured: boolean; healthy: boolean; production: boolean }): RedisDependencyState {
  if (!configured) return production ? "required" : "not_configured";
  return healthy ? "ready" : "unavailable";
}

export function isServiceReady(databaseReady: boolean, redis: RedisDependencyState) {
  return databaseReady && (redis === "ready" || redis === "not_configured");
}
