"use client";

export type OutletSession = { id: string; name: string; role: string; permissions: string[] };
export type AuthenticatedSession = {
  user: { id: string; name: string; email: string };
  outlets: OutletSession[];
};

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "ApiError"; this.status = status; }
}

// Access tokens deliberately live only in memory. The refresh token stays in the
// server-set HttpOnly cookie and is never exposed to browser JavaScript.
let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;
const PENDING_LOGOUT_KEY = "kora-cloud-logout-pending";

export function hasPendingLogout() {
  try { return localStorage.getItem(PENDING_LOGOUT_KEY) === "1"; }
  catch { return true; }
}

function markPendingLogout() {
  try { localStorage.setItem(PENDING_LOGOUT_KEY, "1"); }
  catch { /* Storage failures are treated as pending by hasPendingLogout when storage is inaccessible. */ }
}

async function flushPendingLogout() {
  if (!hasPendingLogout()) return;
  accessToken = null;
  let response: Response;
  try {
    response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError("A previous sign-out is waiting for a network connection.", 503);
  }
  if (!response.ok) throw new ApiError("A previous sign-out could not be confirmed. Connect and try again.", response.status);
  try { localStorage.removeItem(PENDING_LOGOUT_KEY); }
  catch { throw new ApiError("Could not clear the pending sign-out state. Enable browser storage and try again.", 503); }
}

async function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { accessToken?: unknown };
        return typeof body.accessToken === "string" ? body.accessToken : null;
      })
      .catch(() => null)
      .then((token) => { accessToken = token; return token; })
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export function setAccessToken(token: string | null) { accessToken = token; }
export function hasAccessToken() { return accessToken !== null; }
export function getAccessToken() { return accessToken; }

export async function apiFetch(path: string, init: RequestInit = {}) {
  const send = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  };
  let response = await send(accessToken);
  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    const token = await refreshAccessToken();
    if (token) response = await send(token);
  }
  return response;
}

export async function signIn(input: { tenantSlug: string; email: string; password: string }) {
  await flushPendingLogout();
  const response = await fetch("/api/auth/login", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { accessToken?: string; error?: string };
  if (!response.ok || !body.accessToken) throw new Error(body.error ?? "Sign-in failed.");
  accessToken = body.accessToken;
  return readSession();
}

export async function registerRestaurant(input: { tenantName: string; outletName: string; name: string; email: string; password: string }) {
  await flushPendingLogout();
  const response = await fetch("/api/auth/register", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { accessToken?: string; error?: string };
  if (!response.ok || !body.accessToken) throw new ApiError(body.error ?? "Restaurant setup failed.", response.status);
  accessToken = body.accessToken;
  return readSession();
}

export async function readSession() {
  const response = await apiFetch("/api/auth/me");
  if (!response.ok) throw new Error(response.status === 401 ? "Session expired. Sign in again." : "Could not load your account.");
  return await response.json() as AuthenticatedSession;
}

export async function restoreSession() {
  if (hasPendingLogout()) {
    try { await flushPendingLogout(); }
    catch { accessToken = null; return null; }
    accessToken = null;
    return null;
  }
  const token = await refreshAccessToken();
  if (!token) return null;
  try { return await readSession(); }
  catch { accessToken = null; return null; }
}

export async function signOut() {
  // Persist the local sign-out intent before the network call. Keep this latch
  // until a later online restore or sign-in confirms server logout; offline
  // workspace restore must never resurrect a signed-out user.
  markPendingLogout();
  try { await apiFetch("/api/auth/logout", { method: "POST" }); }
  catch { /* The durable latch causes a later online session to retry logout. */ }
  finally { accessToken = null; }
}

export async function readJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status}).`, response.status);
  return body;
}
