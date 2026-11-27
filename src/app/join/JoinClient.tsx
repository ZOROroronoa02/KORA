"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { ApiError, prepareFreshAuthentication, setAccessToken } from "@/lib/client-api";

type Invitation = { email: string; tenantName: string; outletName: string; roleName: string; expiresAt: string };

export default function JoinPage() {
  const [token, setToken] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const tokenFromLink = window.location.hash.slice(1);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    if (!/^[A-Za-z0-9_-]{43}$/.test(tokenFromLink)) {
      setError("This invitation link is incomplete or invalid. Ask the restaurant owner for a fresh link.");
      setLoading(false);
      return;
    }
    setToken(tokenFromLink);
    const controller = new AbortController();
    void fetch("/api/auth/invitations/resolve", {
      method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tokenFromLink }),
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as { invitation?: Invitation; error?: string };
      if (!response.ok || !body.invitation) throw new Error(body.error ?? "This invitation could not be verified.");
      setInvitation(body.invitation);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This invitation could not be verified.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !invitation || busy) return;
    setError("");
    if (password !== confirmPassword) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      await prepareFreshAuthentication();
      const response = await fetch("/api/auth/invitations/accept", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name, phone: phone || undefined, password }),
      });
      const body = await response.json().catch(() => ({})) as { accessToken?: string; error?: string };
      if (!response.ok || !body.accessToken) throw new ApiError(body.error ?? "The invitation could not be accepted.", response.status);
      setAccessToken(body.accessToken);
      window.location.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The invitation could not be accepted.");
      setBusy(false);
    }
  };

  return <main className="join-page">
    <section className="join-card">
      <span className="join-mark" aria-hidden="true">K</span>
      <p className="eyebrow">KORA TEAM ACCESS</p>
      <h1>Join your restaurant</h1>
      {loading ? <p className="muted" role="status">Checking invitation…</p> : invitation ? <>
        <div className="join-invitation-summary">
          <ShieldCheck size={18}/>
          <p><b>{invitation.tenantName}</b><span>{invitation.outletName} · {invitation.roleName}</span><span>Invitation for {invitation.email}</span></p>
        </div>
        <form className="join-form" onSubmit={(event) => void accept(event)}>
          <label>Your name<input autoComplete="name" required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)}/></label>
          <label>Phone (optional)<input autoComplete="tel" type="tel" maxLength={32} value={phone} onChange={(event) => setPhone(event.target.value)}/></label>
          <label>Create password<input autoComplete="new-password" type="password" required minLength={12} maxLength={72} value={password} onChange={(event) => setPassword(event.target.value)}/><small>Use at least 12 characters. Maximum 72 UTF-8 bytes.</small></label>
          <label>Confirm password<input autoComplete="new-password" type="password" required minLength={12} maxLength={72} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)}/></label>
          {error && <p className="join-error" role="alert">{error}</p>}
          <button className="primary-button full-button" type="submit" disabled={busy}>{busy ? "Creating account…" : <>Accept invitation <ArrowRight size={15}/></>}</button>
        </form>
        <p className="join-expiry">This one-time invitation expires {new Date(invitation.expiresAt).toLocaleString()}.</p>
      </> : <p className="join-error" role="alert">{error || "This invitation is unavailable."}</p>}
      {loading && error && <p className="join-error" role="alert">{error}</p>}
      <a className="join-home" href="/">Return to KORA</a>
    </section>
  </main>;
}
