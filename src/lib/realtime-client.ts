import { io, type Socket } from "socket.io-client";

export type KoraRealtimeEvents = {
  "kora:ready": (payload: { outletId: string }) => void;
  "order:new": (payload: unknown) => void;
  "kot:status": (payload: unknown) => void;
  "kot:created": (payload: unknown) => void;
  "kot:item:updated": (payload: unknown) => void;
  "kot:updated": (payload: unknown) => void;
  "kot:recalled": (payload: unknown) => void;
  "kot:86-item": (payload: unknown) => void;
  "connection:outlet-joined": (payload: { outletId: string; serverTimestamp: string }) => void;
  "menu:updated": (payload: unknown) => void;
};

export function connectKoraRealtime(accessToken: string, outletId: string): Socket<KoraRealtimeEvents> {
  const url = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000";
  return io(url, { auth: { accessToken, outletId }, transports: ["websocket", "polling"], withCredentials: true, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelayMax: 10000 });
}
