"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Filter, RefreshCw, ShieldCheck } from "lucide-react";
import { readJson } from "@/lib/client-api";

type AuditEntry = { id: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; reason: string | null; createdAt: string; user: { id: string; name: string; email: string } | null; approvalUser: { id: string; name: string } | null };

export function AuditLogViewer({ outletId, onNotify }: { outletId: string; onNotify: (message: string) => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams({ outletId });
    if (userId.trim()) params.set("userId", userId.trim());
    if (action.trim()) params.set("action", action.trim());
    if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    try { setEntries((await readJson<{ entries: AuditEntry[] }>(`/api/audit?${params}`)).entries); }
    catch (error) { onNotify(error instanceof Error ? error.message : "Audit history could not be loaded."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [outletId]);

  return <><div className="page-title-row"><div><p className="eyebrow">SECURITY & CONTROL</p><h1>Audit log</h1><p className="muted">Sensitive outlet actions with actor and manager approval attribution.</p></div><button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15}/> Refresh</button></div><section className="card content-card"><div className="audit-filters"><label>User ID<input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="Filter by user ID"/></label><label>Action<input value={action} onChange={(event) => setAction(event.target.value)} placeholder="e.g. ORDER_VOIDED"/></label><label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label><label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label><button className="filter-button" onClick={() => void load()}><Filter size={14}/> Apply</button></div><div className="audit-entry-list">{entries.map((entry) => <article className="audit-entry" key={entry.id}><span className="audit-entry-icon"><ShieldCheck size={15}/></span><div><b>{entry.action}</b><p>{entry.entityType}{entry.entityId ? ` · ${entry.entityId}` : ""} · {entry.user?.name ?? "System"}{entry.approvalUser ? ` · approved by ${entry.approvalUser.name}` : ""}</p><small><CalendarDays size={12}/> {new Date(entry.createdAt).toLocaleString("en-IN")}{entry.reason ? ` · ${entry.reason}` : ""}</small>{(entry.before !== null || entry.after !== null) && <details><summary>Change details</summary><pre>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre></details>}</div></article>)}{!entries.length && !loading && <div className="empty-state"><ShieldCheck size={23}/><b>No matching actions</b><span>Adjust the filters or refresh the audit history.</span></div>}</div></section></>;
}
