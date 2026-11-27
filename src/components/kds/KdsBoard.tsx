"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BellRing, Check, ChevronDown, Clock3, Flame, Maximize, Pause, Play, Printer, Radio, RotateCcw, Search, Settings2, Volume2, VolumeX, Wifi, WifiOff, X } from "lucide-react";
import { ApiError, apiFetch, getAccessToken, readJson, restoreSession, type AuthenticatedSession } from "@/lib/client-api";
import { connectKoraRealtime } from "@/lib/realtime-client";
import { aggregateKdsTicketState, nextKdsItemState, slaBand, slaElapsedSeconds, type KdsItemState } from "@/lib/domain/kds";
import { cacheKdsTickets, cacheOfflineWorkspace, getPendingKdsActions, queueKdsAction, readKdsTickets, readOfflineWorkspace, removeKdsAction, updateKdsActionError, type PendingKdsAction } from "@/lib/pos-offline";
import { allPermissionKeys } from "@/lib/permissions";
import { hasFreshOfflinePermissionSnapshot, offlinePermissionsForSnapshot } from "@/lib/offline-permissions";
import css from "./KdsBoard.module.css";

type KdsItem = { id: string; menuItemId: string | null; name: string; quantity: number; variant: string | null; modifiers: unknown; notes: string | null; state: KdsItemState; updatedAt: string };
type KdsLaneState = "QUEUED" | "PREPARING" | "READY";
type Ticket = {
  id: string; kotNumber: number; orderId: string; orderNumber: number; orderType: string; tableLabel: string | null; waiterName: string;
  station: { id: string; name: string } | null; status: string; notes: string | null; isRush: boolean; createdAt: string; updatedAt: string;
  startedAt: string | null; readyAt: string | null; servedAt: string | null; heldAt: string | null; holdReason: string | null; holdDurationSeconds: number;
  undoBumpUntil: string | null; items: KdsItem[];
};
type Station = { id: string; name: string; sortOrder: number };
type KdsSettings = { slaMinutesPerOrderType: Record<string, number>; kdsSoundEnabled: boolean; kdsColumnsByStation: Record<string, unknown> };
type KdsSnapshot = { outlet: { id: string; name: string }; stations: Station[]; tickets: Ticket[]; settings: KdsSettings; serverTimestamp: string };
type KdsFilter = "ALL" | "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "RUSH";
type Metrics = { sampleSize: number; capped: boolean; stations: Array<{ station: string; tickets: number; avgPrepSeconds: number | null; avgHandoffSeconds: number | null; slaBreaches: number }>; items: Array<{ item: string; tickets: number; avgPrepSeconds: number | null }>; hourly: Array<{ hour: number; tickets: number }> };

const filters: Array<{ id: KdsFilter; label: string }> = [
  { id: "ALL", label: "All tickets" }, { id: "DINE_IN", label: "Dine-in" }, { id: "TAKEAWAY", label: "Takeaway" }, { id: "DELIVERY", label: "Delivery" }, { id: "RUSH", label: "Rush" },
];
const defaultKdsColumns: KdsLaneState[] = ["QUEUED", "PREPARING", "READY"];
const kdsLaneLabels: Record<string, string> = { QUEUED: "QUEUED", PREPARING: "PREPARING", READY: "READY TO SERVE" };
function configuredKdsColumns(settings: KdsSettings | null, stationKey: string): KdsLaneState[] {
  const byStation = settings?.kdsColumnsByStation ?? {};
  const raw = byStation[stationKey] ?? byStation.all;
  if (!Array.isArray(raw)) return defaultKdsColumns;
  const selected = raw.filter((value): value is KdsLaneState => defaultKdsColumns.includes(value as KdsLaneState));
  return selected.length ? [...new Set(selected)] : defaultKdsColumns;
}
const typeLabel: Record<string, string> = { DINE_IN: "DINE-IN", TAKEAWAY: "TAKEAWAY", DELIVERY: "DELIVERY", QR: "QR ORDER", AGGREGATOR: "AGGREGATOR" };
const ticketLane = (ticket: Ticket) => aggregateKdsTicketState(ticket.items.map((item) => item.state));
const activeStates = (ticket: Ticket) => ticket.items.filter((item) => item.state !== "OUT_OF_STOCK").map((item) => item.state);
const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const itemModifiers = (modifiers: unknown) => {
  if (!modifiers) return "";
  if (typeof modifiers === "string") return modifiers;
  if (Array.isArray(modifiers)) return modifiers.map((value) => typeof value === "string" ? value : (value && typeof value === "object" && "name" in value ? String(value.name) : "")).filter(Boolean).join(", ");
  if (typeof modifiers === "object") return Object.entries(modifiers as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value)}`).join(", ");
  return "";
};

function Elapsed({ ticket, targetMinutes }: { ticket: Ticket; targetMinutes: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = slaElapsedSeconds({ createdAt: ticket.createdAt, now, holdDurationSeconds: ticket.holdDurationSeconds, heldAt: ticket.heldAt });
  const band = slaBand(elapsed, targetMinutes);
  return <span className={`${css.elapsed} ${css[band]}`} aria-label={`Elapsed ${formatDuration(elapsed)}; ${band === "red" ? "SLA breached" : band === "amber" ? "near SLA target" : "within SLA target"}`}><Clock3 size={14} />{formatDuration(elapsed)}{ticket.heldAt && <small>PAUSED</small>}</span>;
}

const TicketCard = memo(function TicketCard({ ticket, targetMinutes, selected, permissions, onSelect, onCycle, on86, onAction, onReprint, undoVisible }: {
  ticket: Ticket; targetMinutes: number; selected: boolean; permissions: string[]; undoVisible: boolean;
  onSelect: (ticket: Ticket) => void; onCycle: (ticket: Ticket, item: KdsItem) => void; on86: (ticket: Ticket, item: KdsItem) => void;
  onAction: (ticket: Ticket, action: string) => void; onReprint: (ticket: Ticket) => void;
}) {
  const lane = ticketLane(ticket);
  const canBump = activeStates(ticket).length > 0 && activeStates(ticket).every((state) => state === "READY" || state === "BUMPED");
  const allQueued = ticket.items.some((item) => item.state === "QUEUED");
  const worst = Math.max(...ticket.items.map((item) => slaElapsedSeconds({ createdAt: ticket.createdAt, now: Date.now(), holdDurationSeconds: ticket.holdDurationSeconds, heldAt: ticket.heldAt })));
  const band = slaBand(worst, targetMinutes);
  const canReprint = permissions.includes("kot.reprint");
  const canMark86 = permissions.includes("kds.86");
  return <article className={`${css.ticket} ${css[`ticket_${lane.toLowerCase()}`]} ${css[`border_${band}`]} ${ticket.isRush ? css.rush : ""} ${ticket.heldAt ? css.held : ""} ${selected ? css.selected : ""}`} data-ticket-id={ticket.id} tabIndex={0} onFocus={() => onSelect(ticket)} onClick={() => onSelect(ticket)} aria-label={`Kitchen ticket ${ticket.kotNumber}, ${ticket.orderType}, ${lane}`}>
    <header className={css.ticketHeader}>
      <div className={css.ticketIdentity}><b>KOT #{ticket.kotNumber}</b><span className={`${css.orderBadge} ${css[`type_${ticket.orderType.toLowerCase()}`]}`}>{typeLabel[ticket.orderType] ?? ticket.orderType}{ticket.tableLabel ? ` · ${ticket.tableLabel}` : ""}</span></div>
      {ticket.isRush && <span className={css.rushFlag}><Flame size={14} /> RUSH</span>}
    </header>
    <div className={css.ticketMeta}><span>{ticket.waiterName || "Staff"}</span><span>{ticket.station?.name ?? "General"}</span><Elapsed ticket={ticket} targetMinutes={targetMinutes} /></div>
    {ticket.heldAt && <div className={css.holdNotice}><Pause size={13} /> Held · {ticket.holdReason}</div>}
    <div className={css.lines}>
      {ticket.items.map((item) => {
        const modifierText = [item.variant, itemModifiers(item.modifiers), item.notes].filter(Boolean).join(" · ");
        const next = nextKdsItemState(item.state);
        return <div className={`${css.line} ${item.state === "OUT_OF_STOCK" ? css.oos : ""}`} key={item.id}>
          <button className={css.lineButton} type="button" disabled={!next || Boolean(ticket.heldAt)} onClick={(event) => { event.stopPropagation(); if (next) onCycle(ticket, item); }} aria-label={`${item.quantity} ${item.name}, state ${item.state}. ${next ? `Advance to ${next}` : "final state"}`}>
            <span className={css.qty}>{item.quantity}×</span><span className={css.itemText}><b>{item.name}</b>{modifierText && <small>{modifierText}</small>}</span>
            <span className={`${css.stateChip} ${css[`state_${item.state.toLowerCase()}`]}`}>{item.state.replaceAll("_", " ")}</span>
          </button>
          {canMark86 && item.state !== "OUT_OF_STOCK" && item.state !== "BUMPED" && <button className={css.outButton} type="button" onClick={(event) => { event.stopPropagation(); on86(ticket, item); }} aria-label={`Mark ${item.name} out of stock`}>86</button>}
        </div>;
      })}
    </div>
    {ticket.notes && <p className={css.ticketNote}>NOTE · {ticket.notes}</p>}
    <footer className={css.ticketActions}>
      {allQueued && lane !== "SERVED" && <button type="button" onClick={(event) => { event.stopPropagation(); onAction(ticket, "start-all"); }}><Play size={16} /> Start all</button>}
      {ticket.heldAt ? <button type="button" onClick={(event) => { event.stopPropagation(); onAction(ticket, "resume"); }}><Play size={16} /> Resume</button> : lane !== "SERVED" && lane !== "CANCELLED" && <button type="button" onClick={(event) => { event.stopPropagation(); onAction(ticket, "hold"); }}><Pause size={16} /> Hold</button>}
      {canBump && !ticket.heldAt && <button className={css.primaryAction} type="button" onClick={(event) => { event.stopPropagation(); onAction(ticket, "bump-ticket"); }}><Check size={16} /> Bump ticket</button>}
      {undoVisible && <button className={css.undoAction} type="button" onClick={(event) => { event.stopPropagation(); onAction(ticket, "undo-bump"); }}><RotateCcw size={16} /> Undo bump</button>}
      {canReprint && <button className={css.iconAction} type="button" onClick={(event) => { event.stopPropagation(); onReprint(ticket); }} aria-label={`Reprint KOT ${ticket.kotNumber}`}><Printer size={17} /></button>}
    </footer>
  </article>;
});

export default function KdsBoard() {
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [offlineWorkspace, setOfflineWorkspace] = useState<Awaited<ReturnType<typeof readOfflineWorkspace>>>(undefined);
  const [outletId, setOutletId] = useState("");
  const [snapshot, setSnapshot] = useState<KdsSnapshot | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [stationId, setStationId] = useState("all");
  const [filter, setFilter] = useState<KdsFilter>("ALL");
  const [sortWorstFirst, setSortWorstFirst] = useState(false);
  const [search, setSearch] = useState("");
  const [online, setOnline] = useState(true);
  const [permissionClock, setPermissionClock] = useState(Date.now());
  const [socketConnected, setSocketConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingActions, setPendingActions] = useState<PendingKdsAction[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState("");
  const [undoTicketId, setUndoTicketId] = useState("");
  const [undoTicketData, setUndoTicketData] = useState<Ticket | null>(null);
  const [recallOpen, setRecallOpen] = useState(false);
  const [recallTickets, setRecallTickets] = useState<Ticket[]>([]);
  const [holdTicket, setHoldTicket] = useState<Ticket | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [stationSetupOpen, setStationSetupOpen] = useState(false);
  const [savingColumns, setSavingColumns] = useState(false);
  const [menuItems, setMenuItems] = useState<Array<{ id: string; name: string; category: string; stationId: string | null }>>([]);
  const [newStationName, setNewStationName] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundArmed, setSoundArmed] = useState(false);
  const [clock, setClock] = useState<Date | null>(null);
  const [visibleCount, setVisibleCount] = useState(100);
  const socketRef = useRef<ReturnType<typeof connectKoraRealtime> | null>(null);
  const soundConfigured = useRef(false);
  const recallActionRef = useRef<() => Promise<void>>(async () => undefined);
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const actionRef = useRef<(ticket: Ticket, action: string, item?: KdsItem, reason?: string) => Promise<void>>(async () => undefined);
  const rootRef = useRef<HTMLElement>(null);

  const selectedOutlet = session?.outlets.find((outlet) => outlet.id === outletId) ?? null;
  const offlineWorkspaceMatches = offlineWorkspace?.outletId === outletId;
  const offlineSnapshotFresh = Boolean(offlineWorkspaceMatches && hasFreshOfflinePermissionSnapshot(offlineWorkspace.savedAt, permissionClock));
  const permissions = online && selectedOutlet
    ? selectedOutlet.permissions
    : offlineWorkspaceMatches
      ? offlinePermissionsForSnapshot(offlineWorkspace.savedAt, offlineWorkspace.permissions, new Set<string>(allPermissionKeys), permissionClock)
      : [];
  const hasKdsAccess = permissions.includes("kds.view");
  const outletName = selectedOutlet?.name ?? (offlineWorkspace?.outletId === outletId ? offlineWorkspace.outletName : snapshot?.outlet.name) ?? "Kitchen";
  const allTickets = tickets;
  const filteredTickets = useMemo(() => {
    let result = allTickets.filter((ticket) => ticketLane(ticket) !== "SERVED" && ticketLane(ticket) !== "CANCELLED");
    if (stationId !== "all") result = result.filter((ticket) => ticket.station?.id === stationId);
    if (filter === "RUSH") result = result.filter((ticket) => ticket.isRush);
    else if (filter !== "ALL") result = result.filter((ticket) => filter === "DELIVERY" ? ["DELIVERY", "QR", "AGGREGATOR"].includes(ticket.orderType) : ticket.orderType === filter);
    const query = search.trim().toLowerCase();
    if (query) result = result.filter((ticket) => String(ticket.kotNumber).includes(query) || String(ticket.orderNumber).includes(query) || (ticket.tableLabel ?? "").toLowerCase().includes(query) || ticket.waiterName.toLowerCase().includes(query));
    if (sortWorstFirst) result = [...result].sort((a, b) => slaElapsedSeconds({ createdAt: b.createdAt, now: Date.now(), holdDurationSeconds: b.holdDurationSeconds }) - slaElapsedSeconds({ createdAt: a.createdAt, now: Date.now(), holdDurationSeconds: a.holdDurationSeconds }));
    return result.slice(0, visibleCount);
  }, [allTickets, filter, search, sortWorstFirst, stationId, visibleCount]);
  const columns = useMemo(() => configuredKdsColumns(snapshot?.settings ?? null, stationId), [snapshot?.settings, stationId]);
  const lanes = useMemo(() => columns.map((id) => ({
    id,
    label: kdsLaneLabels[id],
    tickets: filteredTickets.filter((ticket) => ticketLane(ticket) === id),
  })), [columns, filteredTickets]);

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  }, []);

  const reload = useCallback(async () => {
    if (!outletId || !navigator.onLine || !getAccessToken()) {
      const cached = outletId ? await readKdsTickets(outletId).catch(() => undefined) : undefined;
      if (cached && Date.now() - cached.savedAt <= 24 * 60 * 60_000) {
        setTickets(cached.tickets as Ticket[]);
        if (cached.stations && cached.settings && cached.outlet) setSnapshot({ tickets: cached.tickets as Ticket[], stations: cached.stations as Station[], settings: cached.settings as KdsSettings, outlet: cached.outlet as KdsSnapshot["outlet"], serverTimestamp: new Date(cached.savedAt).toISOString() });
      }
      setLoading(false);
      return;
    }
    try {
      const value = await readJson<KdsSnapshot>(`/api/kds?outletId=${encodeURIComponent(outletId)}`);
      setSnapshot(value);
      setTickets(value.tickets);
      setError("");
      if (!soundConfigured.current) { soundConfigured.current = true; setSoundEnabled(value.settings.kdsSoundEnabled); }
      await cacheKdsTickets(outletId, value.tickets, { stations: value.stations, settings: value.settings, outlet: value.outlet }).catch(() => undefined);
    } catch (loadError) {
      const cached = await readKdsTickets(outletId).catch(() => undefined);
      if (cached && Date.now() - cached.savedAt <= 24 * 60 * 60_000) {
        setTickets(cached.tickets as Ticket[]);
        if (cached.stations && cached.settings && cached.outlet) setSnapshot({ tickets: cached.tickets as Ticket[], stations: cached.stations as Station[], settings: cached.settings as KdsSettings, outlet: cached.outlet as KdsSnapshot["outlet"], serverTimestamp: new Date(cached.savedAt).toISOString() });
      }
      else setError(loadError instanceof Error ? loadError.message : "Kitchen tickets could not be loaded.");
    } finally { setLoading(false); }
  }, [outletId, stationId]);
  useEffect(() => { reloadRef.current = reload; }, [reload]);

  const sendAction = useCallback(async (ticket: Ticket, action: string, item?: KdsItem, reason?: string) => {
    const mutation: PendingKdsAction = {
      clientMutationId: crypto.randomUUID(), outletId, action, ticketId: ticket.id, itemId: item?.id,
      expectedUpdatedAt: item?.updatedAt, reason, createdAt: Date.now(),
    };
    const queueOffline = !navigator.onLine || !socketConnected;
    if (queueOffline) {
      await queueKdsAction(mutation);
      setPendingActions((current) => [...current.filter((entry) => entry.clientMutationId !== mutation.clientMutationId), mutation]);
      setTickets((current) => {
        const next = current.map((entry) => {
          if (entry.id !== ticket.id) return entry;
          const updatedItems = item && (action === "item-cycle" || action === "item-86") ? entry.items.map((line) => line.id === item.id ? { ...line, state: action === "item-86" ? "OUT_OF_STOCK" as const : (nextKdsItemState(line.state) ?? line.state), updatedAt: new Date().toISOString() } : line) : action === "start-all" ? entry.items.map((line) => line.state === "QUEUED" ? { ...line, state: "COOKING" as const, updatedAt: new Date().toISOString() } : line) : action === "bump-ticket" ? entry.items.map((line) => line.state === "READY" ? { ...line, state: "BUMPED" as const, updatedAt: new Date().toISOString() } : line) : action === "undo-bump" || action === "recall" ? entry.items.map((line) => line.state === "BUMPED" ? { ...line, state: "READY" as const, updatedAt: new Date().toISOString() } : line) : entry.items;
          return { ...entry, items: updatedItems, heldAt: action === "hold" ? new Date().toISOString() : action === "resume" ? null : entry.heldAt, holdReason: action === "hold" ? reason ?? null : action === "resume" ? null : entry.holdReason, status: aggregateKdsTicketState(updatedItems.map((line) => line.state)), servedAt: action === "bump-ticket" ? new Date().toISOString() : action === "undo-bump" || action === "recall" ? null : entry.servedAt };
        });
        void cacheKdsTickets(outletId, next);
        return next;
      });
      if (action === "bump-ticket") { setUndoTicketId(ticket.id); setUndoTicketData(ticket); window.setTimeout(() => { setUndoTicketId(""); setUndoTicketData(null); }, 5_000); }
      notify("Action queued. It will sync when the kitchen connection returns.");
      return;
    }
    setSyncing(true);
    try {
      const result = await readJson<{ status: string }>(`/api/kds/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...mutation, action, outletId, ticketId: ticket.id, itemId: item?.id, reason, expectedUpdatedAt: item?.updatedAt }) });
      if (action === "bump-ticket" || (action === "item-cycle" && result.status === "SERVED")) { setUndoTicketId(ticket.id); setUndoTicketData(ticket); window.setTimeout(() => { setUndoTicketId((value) => value === ticket.id ? "" : value); setUndoTicketData((value) => value?.id === ticket.id ? null : value); }, 5_000); }
      if (action === "recall") setRecallOpen(false);
      if (action === "undo-bump") { setUndoTicketId(""); setUndoTicketData(null); }
      void reloadRef.current();
    } catch (actionError) { notify(actionError instanceof ApiError ? actionError.message : "Kitchen action failed. Refresh the ticket and retry."); }
    finally { setSyncing(false); }
  }, [outletId, socketConnected, notify]);
  useEffect(() => { actionRef.current = sendAction; }, [sendAction]);

  const flushPending = useCallback(async () => {
    if (!navigator.onLine || !socketConnected || !getAccessToken() || !outletId) return;
    const queued = await getPendingKdsActions(outletId).catch(() => []);
    const unresolved: PendingKdsAction[] = [];
    const latestItemVersion = new Map<string, string>();
    for (let index = 0; index < queued.length; index++) {
      const action = queued[index];
      try {
        const versionedAction = action.itemId && latestItemVersion.has(action.itemId) ? { ...action, expectedUpdatedAt: latestItemVersion.get(action.itemId) } : action;
        const response = await apiFetch("/api/kds/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(versionedAction) });
        if (response.ok) {
          const result = await response.json().catch(() => ({})) as { items?: Array<{ id: string; updatedAt: string }> };
          for (const item of result.items ?? []) latestItemVersion.set(item.id, item.updatedAt);
          await removeKdsAction(action.clientMutationId);
        }
        else {
          const body = await response.json().catch(() => ({})) as { error?: string };
          await updateKdsActionError(action.clientMutationId, body.error ?? `Sync failed (${response.status}).`);
          unresolved.push({ ...action, lastError: body.error ?? `Sync failed (${response.status}).` });
        }
      } catch {
        await updateKdsActionError(action.clientMutationId, "Connection interrupted before sync.");
        unresolved.push({ ...action, lastError: "Connection interrupted before sync." });
        unresolved.push(...queued.slice(index + 1).map((pending) => ({ ...pending, lastError: "Waiting for the previous offline action to sync." })));
        break;
      }
    }
    setPendingActions(unresolved);
    if (queued.length > 0 && unresolved.length === 0) { notify("Kitchen actions synced."); await reloadRef.current(); }
  }, [outletId, socketConnected, notify]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await readOfflineWorkspace().catch(() => undefined);
      if (!cancelled) setOfflineWorkspace(cached);
      const restored = await restoreSession();
      if (cancelled) return;
      if (restored) setSession(restored);
      const savedOutlet = typeof localStorage !== "undefined" ? localStorage.getItem("kora-kds-outlet") : null;
      const fallbackOutlet = restored?.outlets.find((entry) => entry.id === savedOutlet)?.id ?? restored?.outlets[0]?.id ?? cached?.outletId ?? "";
      setOutletId(fallbackOutlet);
      if (restored) {
        const active = restored.outlets.find((entry) => entry.id === fallbackOutlet);
        if (active) void cacheOfflineWorkspace({ userId: restored.user.id, userName: restored.user.name, outletId: active.id, outletName: active.name, role: active.role, permissions: active.permissions }).then(() => readOfflineWorkspace()).then((workspace) => { if (!cancelled) setOfflineWorkspace(workspace); }).catch(() => undefined);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!outletId) return;
    localStorage.setItem("kora-kds-outlet", outletId);
    void reload();
    void getPendingKdsActions(outletId).then(setPendingActions).catch(() => undefined);
  }, [outletId, reload]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => { setOnline(false); setSocketConnected(false); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);

  useEffect(() => {
    if (online || !offlineWorkspaceMatches) return;
    const updatePermissionClock = () => setPermissionClock(Date.now());
    updatePermissionClock();
    const timer = window.setInterval(updatePermissionClock, 5000);
    document.addEventListener("visibilitychange", updatePermissionClock);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", updatePermissionClock); };
  }, [online, offlineWorkspaceMatches, offlineWorkspace?.savedAt]);

  useEffect(() => {
    if (!outletId || !hasKdsAccess || !online || !getAccessToken()) { socketRef.current?.disconnect(); socketRef.current = null; setSocketConnected(false); return; }
    const socket = connectKoraRealtime(getAccessToken()!, outletId);
    socketRef.current = socket;
    socket.on("connect", () => { setSocketConnected(true); void flushPending(); void reloadRef.current(); });
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("connect_error", () => setSocketConnected(false));
    for (const event of ["kot:created", "kot:item:updated", "kot:updated", "kot:recalled", "kot:86-item", "kot:status", "order:new"] as const) {
      socket.on(event, (payload) => {
        if (event === "kot:created" && payload && typeof payload === "object" && "ticketId" in payload) {
          const newId = String((payload as { ticketId: unknown }).ticketId);
          setTickets((current) => {
            if (current.some((ticket) => ticket.id === newId)) return current;
            if (soundArmed && soundEnabled && document.visibilityState === "visible") playChime(Boolean("isRush" in payload && payload.isRush === true));
            return current;
          });
        }
        void reloadRef.current();
      });
    }
    return () => { socket.disconnect(); if (socketRef.current === socket) socketRef.current = null; };
  }, [outletId, hasKdsAccess, online, flushPending, soundArmed, soundEnabled]);

  useEffect(() => {
    setClock(new Date());
    const timer = window.setInterval(() => setClock(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { if (navigator.onLine && !socketConnected) void reloadRef.current(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [socketConnected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input,textarea,select") || target.isContentEditable) return;
      const visible = filteredTickets;
      const currentIndex = Math.max(0, visible.findIndex((ticket) => ticket.id === selectedTicketId));
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = visible[(currentIndex + delta + visible.length) % visible.length];
        if (next) { setSelectedTicketId(next.id); document.querySelector<HTMLElement>(`[data-ticket-id="${CSS.escape(next.id)}"]`)?.focus(); }
      } else if (event.key === "Enter" && visible[currentIndex]) {
        setSelectedTicketId(visible[currentIndex].id);
        document.querySelector<HTMLElement>(`[data-ticket-id="${CSS.escape(visible[currentIndex].id)}"]`)?.focus();
      } else if (event.key.toLowerCase() === "r") void recallActionRef.current();
      else if (/^[1-9]$/.test(event.key)) setFilter(filters[Math.min(Number(event.key) - 1, filters.length - 1)].id);
      else if (visible[currentIndex] && event.key.toLowerCase() === "s") void actionRef.current(visible[currentIndex], "start-all");
      else if (visible[currentIndex] && event.key.toLowerCase() === "t") void actionRef.current(visible[currentIndex], "bump-ticket");
      else if (visible[currentIndex] && event.key.toLowerCase() === "b") {
        const item = visible[currentIndex].items.find((line) => nextKdsItemState(line.state));
        if (item) void actionRef.current(visible[currentIndex], "item-cycle", item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredTickets, selectedTicketId]);

  const requestRecall = useCallback(async () => {
    try {
      const value = await readJson<KdsSnapshot>(`/api/kds?outletId=${encodeURIComponent(outletId)}&includeServed=1`);
      setRecallTickets(value.tickets.filter((ticket) => ticket.status === "SERVED" && ticket.servedAt && Date.now() - Date.parse(ticket.servedAt) <= 30 * 60_000 && (stationId === "all" || ticket.station?.id === stationId)));
    } catch (loadError) { notify(loadError instanceof Error ? loadError.message : "Recall list could not be loaded."); }
    setRecallOpen(true);
  }, [outletId, stationId, notify]);
  useEffect(() => { recallActionRef.current = requestRecall; }, [requestRecall]);

  const openMetrics = useCallback(async () => {
    try { setMetrics(await readJson<Metrics>(`/api/kds/metrics?outletId=${encodeURIComponent(outletId)}${stationId !== "all" ? `&stationId=${encodeURIComponent(stationId)}` : ""}`)); setMetricsOpen(true); }
    catch (loadError) { notify(loadError instanceof Error ? loadError.message : "Kitchen metrics are unavailable."); }
  }, [outletId, stationId, notify]);

  const openStationSetup = useCallback(async () => {
    if (!selectedOutlet) return;
    try {
      const categories = await readJson<Array<{ name: string; items: Array<{ id: string; name: string; outletPrices?: Array<{ stationId: string | null }> }> }>>(`/api/menu?outletId=${encodeURIComponent(outletId)}`);
      setMenuItems(categories.flatMap((category) => category.items.map((item) => ({ id: item.id, name: item.name, category: category.name, stationId: item.outletPrices?.[0]?.stationId ?? null }))));
      setStationSetupOpen(true);
    } catch (loadError) { notify(loadError instanceof Error ? loadError.message : "Station settings could not be loaded."); }
  }, [selectedOutlet, outletId, notify]);

  const createStation = useCallback(async () => {
    try {
      const created = await readJson<Station>("/api/kds/stations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, name: newStationName }) });
      setNewStationName("");
      setSnapshot((current) => current ? { ...current, stations: [...current.stations, created].sort((a, b) => a.sortOrder - b.sortOrder) } : current);
      notify(`${created.name} station created.`);
    } catch (createError) { notify(createError instanceof Error ? createError.message : "Station could not be created."); }
  }, [outletId, newStationName, notify]);

  const assignStation = useCallback(async (menuItemId: string, targetStationId: string) => {
    try {
      await readJson("/api/kds/stations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, menuItemId, stationId: targetStationId }) });
      setMenuItems((current) => current.map((item) => item.id === menuItemId ? { ...item, stationId: targetStationId } : item));
      notify("Kitchen routing saved. New orders will use this station.");
    } catch (assignError) { notify(assignError instanceof Error ? assignError.message : "Kitchen routing could not be saved."); }
  }, [outletId, notify]);

  const saveColumns = useCallback(async (nextColumns: KdsLaneState[]) => {
    if (savingColumns || !snapshot || !permissions.includes("settings.manage")) return;
    setSavingColumns(true);
    try {
      const currentByStation = snapshot.settings.kdsColumnsByStation ?? {};
      const response = await readJson<{ settings: KdsSettings }>("/api/outlet-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, kdsColumnsByStation: { ...currentByStation, [stationId]: nextColumns } }),
      });
      setSnapshot((current) => current ? { ...current, settings: response.settings } : current);
      notify("Kitchen lane layout saved for this station.");
    } catch (saveError) {
      notify(saveError instanceof Error ? saveError.message : "Kitchen lane layout could not be saved.");
    } finally {
      setSavingColumns(false);
    }
  }, [outletId, notify, permissions, savingColumns, snapshot, stationId]);

  const toggleColumn = useCallback((state: KdsLaneState, enabled: boolean) => {
    const next = enabled ? [...columns, state] : columns.filter((value) => value !== state);
    if (next.length) void saveColumns(next);
  }, [columns, saveColumns]);

  const moveColumn = useCallback((index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    void saveColumns(next);
  }, [columns, saveColumns]);

  const reprint = useCallback(async (ticket: Ticket) => {
    try {
      const response = await apiFetch(`/api/kds/tickets/${encodeURIComponent(ticket.id)}/reprint?outletId=${encodeURIComponent(outletId)}`);
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? `Reprint request failed (${response.status}).`); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `KOT-${ticket.kotNumber}.bin`; anchor.click(); URL.revokeObjectURL(url);
      notify("ESC/POS ticket downloaded for the connected printer bridge.");
    } catch (printError) { notify(printError instanceof Error ? printError.message : "KOT reprint failed."); }
  }, [outletId, notify]);

  const executeCardAction = useCallback((ticket: Ticket, action: string) => {
    if (action === "hold") { setHoldTicket(ticket); setHoldReason(""); return; }
    if (action === "undo-bump" && undoTicketId === ticket.id) { setUndoTicketId(""); setUndoTicketData(null); }
    void sendAction(ticket, action);
  }, [sendAction, undoTicketId]);

  const selectTicket = useCallback((ticket: Ticket) => setSelectedTicketId(ticket.id), []);
  const cycleItem = useCallback((ticket: Ticket, item: KdsItem) => void sendAction(ticket, "item-cycle", item), [sendAction]);
  const markOutOfStock = useCallback((ticket: Ticket, item: KdsItem) => void sendAction(ticket, "item-86", item), [sendAction]);

  const confirmHold = useCallback(() => {
    if (!holdTicket || holdReason.trim().length < 3) return;
    void sendAction(holdTicket, "hold", undefined, holdReason.trim());
    setHoldTicket(null); setHoldReason("");
  }, [holdTicket, holdReason, sendAction]);

  const changeOutlet = useCallback((nextOutletId: string) => {
    setOutletId(nextOutletId);
    soundConfigured.current = false;
    setSnapshot(null); setTickets([]); setStationId("all"); setSelectedTicketId("");
    const target = session?.outlets.find((entry) => entry.id === nextOutletId);
    if (target && session) void cacheOfflineWorkspace({ userId: session.user.id, userName: session.user.name, outletId: target.id, outletName: target.name, role: target.role, permissions: target.permissions }).then(() => readOfflineWorkspace()).then(setOfflineWorkspace).catch(() => undefined);
  }, [session]);

  const newTicketCount = tickets.filter((ticket) => !ticket.startedAt && ticketLane(ticket) === "QUEUED").length;
  const targetMinutes = (ticket: Ticket) => Number(snapshot?.settings.slaMinutesPerOrderType[ticket.orderType] ?? 10);
  const connectionGood = online && socketConnected;
  const queueConflicts = pendingActions.filter((action) => action.lastError).length;
  const discardConflicts = useCallback(async () => {
    const conflicts = pendingActions.filter((action) => action.lastError);
    for (const action of conflicts) await removeKdsAction(action.clientMutationId);
    setPendingActions((current) => current.filter((action) => !action.lastError));
    notify("Conflicted offline actions discarded. Reload the board to verify ticket state.");
  }, [pendingActions, notify]);

  const maxHourlyTickets = metrics ? Math.max(1, ...metrics.hourly.map((hour) => hour.tickets)) : 1;

  if (!loading && !hasKdsAccess) {
    return <main className={css.accessPage}><div><Radio size={32} /><h1>No kitchen access</h1><p>This outlet account has no <code>kds.view</code> permission. Ask an owner or manager to assign Kitchen access.</p><a href="/">Return to KORA</a></div></main>;
  }

  return <main ref={rootRef} className={css.root} onPointerDown={() => setSoundArmed(true)}>
    <header className={css.header}>
      <div className={css.brand}><span className={css.brandMark}>K</span><div><b>KORA <span>KITCHEN</span></b><small>{outletName}</small></div></div>
      <div className={css.headerCenter}><span className={css.clock}>{clock?.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }) ?? "--:--:--"}</span><span className={`${css.connection} ${connectionGood ? css.online : css.offline}`}><i />{connectionGood ? "LIVE" : online ? "RECONNECTING" : "OFFLINE"}</span></div>
      <div className={css.headerControls}>
        {session && session.outlets.length > 1 && <label className={css.outletSelect}><span className={css.srOnly}>Outlet</span><select value={outletId} onChange={(event) => changeOutlet(event.target.value)}>{session.outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}</select><ChevronDown size={14}/></label>}
        <label className={css.stationSelect}><span className={css.srOnly}>Kitchen station</span><select value={stationId} onChange={(event) => setStationId(event.target.value)}><option value="all">All stations</option>{snapshot?.stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select><ChevronDown size={14}/></label>
        <button className={css.squareButton} onClick={() => { soundConfigured.current = true; setSoundEnabled((value) => !value); setSoundArmed(true); }} aria-label={soundEnabled ? "Mute kitchen sounds" : "Enable kitchen sounds"}>{soundEnabled ? <Volume2 size={19}/> : <VolumeX size={19}/>}</button>
        <button className={css.squareButton} onClick={() => void rootRef.current?.requestFullscreen?.()} aria-label="Enter fullscreen"><Maximize size={18}/></button>
      </div>
    </header>
    <section className={css.toolbar}>
      <div className={css.filters}>{filters.map((option, index) => <button key={option.id} className={`${css.filterChip} ${filter === option.id ? css.filterActive : ""}`} onClick={() => { setFilter(option.id); setVisibleCount(100); }}><span className={css.srOnly}>Shortcut {index + 1}. </span>{option.label}{option.id === "RUSH" && <Flame size={14}/>}</button>)}</div>
      <div className={css.toolbarRight}>
        <label className={css.search}><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Table, token or KOT…" aria-label="Search by table, token, or KOT"/><kbd>/</kbd></label>
        <button className={`${css.toolButton} ${sortWorstFirst ? css.toolActive : ""}`} onClick={() => setSortWorstFirst((value) => !value)} title="Sort by longest wait"><Activity size={15}/>{sortWorstFirst ? "Worst first" : "FIFO"}</button>
        {permissions.includes("reports.view.kds_sla") && <button className={css.toolButton} onClick={() => void openMetrics()}><Activity size={15}/> Performance</button>}
        {permissions.includes("menu.edit") && <button className={css.toolButton} onClick={() => void openStationSetup()}><Settings2 size={15}/> Stations</button>}
        {permissions.includes("kds.recall") && <button className={css.toolButton} onClick={() => void requestRecall()}><RotateCcw size={15}/> Recall</button>}
      </div>
    </section>
    {(!connectionGood || pendingActions.length > 0) && <div className={`${css.statusBanner} ${queueConflicts ? css.conflictBanner : ""}`} role="status">
      {!connectionGood ? <><WifiOff size={17}/><span>{online ? "Kitchen connection is reconnecting. Cached tickets remain available; actions will sync when the connection returns." : offlineSnapshotFresh ? "Offline mode. Cached tickets and kitchen actions are available provisionally; the server rechecks permissions when they sync." : "Offline permission snapshot expired. Kitchen access and actions are disabled until the outlet is revalidated online."}</span></> : <><Wifi size={17}/><span>{pendingActions.length} queued kitchen action{pendingActions.length === 1 ? "" : "s"} awaiting sync.</span></>}
      {queueConflicts > 0 && <span className={css.conflictCount}>{queueConflicts} need review</span>}
      {queueConflicts > 0 && <button className={css.discardButton} onClick={() => void discardConflicts()}>Discard conflicted actions</button>}
    </div>}
    {error && <div className={css.errorBanner} role="alert">{error}<button onClick={() => void reload()}><RotateCcw size={14}/> Retry</button></div>}
    {notice && <div className={css.toast} role="status">{notice}</div>}
    {undoTicketData && <div className={css.undoToast} role="status"><span>KOT #{undoTicketData.kotNumber} bumped</span><button onClick={() => executeCardAction(undoTicketData, "undo-bump")}><RotateCcw size={15}/> Undo · 5s</button></div>}
    <section className={css.statsBar}>
      <span><i className={css.liveDot}/>{filteredTickets.length} active tickets</span><span><Clock3 size={14}/> FIFO queue</span><span><BellRing size={14}/>{newTicketCount} new</span><span>{syncing ? "Saving kitchen update…" : `${pendingActions.length} offline actions`}</span>
      <small>Keys · ← → navigate · B item · T ticket · S start · R recall · 1–5 filters</small>
    </section>
    <section className={css.board} aria-label="Kitchen ticket board">
      {lanes.map((lane) => <div className={css.lane} key={lane.id}>
        <div className={css.laneHeader}><span className={`${css.laneDot} ${css[`dot_${lane.id.toLowerCase()}`]}`}/><h2>{lane.label}</h2><span className={css.laneCount}>{lane.tickets.length}</span></div>
        <div className={css.laneGrid}>
          {lane.tickets.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} targetMinutes={targetMinutes(ticket)} selected={selectedTicketId === ticket.id} permissions={permissions} onSelect={selectTicket} onCycle={cycleItem} on86={markOutOfStock} onAction={executeCardAction} onReprint={reprint} undoVisible={undoTicketId === ticket.id} />)}
          {!lane.tickets.length && <div className={css.laneEmpty}><Check size={18}/><span>{lane.id === "READY" ? "Nothing ready yet" : "No tickets waiting"}</span></div>}
        </div>
      </div>)}
    </section>
    {filteredTickets.length >= visibleCount && allTickets.length > visibleCount && <button className={css.moreTickets} onClick={() => setVisibleCount((count) => count + 100)}>Show next 100 tickets</button>}
    {loading && <div className={css.loading}><span className={css.spinner}/>Loading kitchen tickets…</div>}
    {!loading && !filteredTickets.length && !error && <div className={css.emptyBoard}><Check size={24}/><b>Kitchen is caught up</b><span>New tickets appear here when orders are sent from POS.</span></div>}
    <footer className={css.footer}><span><span className={css.brandMini}>K</span> KORA KITCHEN DISPLAY</span><span>Updated {snapshot?.serverTimestamp ? new Date(snapshot.serverTimestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "from this device"}</span></footer>

    {holdTicket && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHoldTicket(null); }}><section className={css.modal} role="dialog" aria-modal="true" aria-labelledby="hold-title"><button className={css.modalClose} onClick={() => setHoldTicket(null)} aria-label="Close"><X size={18}/></button><Pause size={24}/><h2 id="hold-title">Hold KOT #{holdTicket.kotNumber}</h2><p>Add a short reason so the next cook knows why this ticket paused.</p><label className={css.field}>Reason<input autoFocus maxLength={240} value={holdReason} onChange={(event) => setHoldReason(event.target.value)} placeholder="Waiting for guest confirmation"/></label><div className={css.modalActions}><button onClick={() => setHoldTicket(null)}>Cancel</button><button className={css.primaryAction} disabled={holdReason.trim().length < 3} onClick={confirmHold}>Hold ticket</button></div></section></div>}

    {recallOpen && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecallOpen(false); }}><section className={`${css.modal} ${css.wideModal}`} role="dialog" aria-modal="true" aria-labelledby="recall-title"><button className={css.modalClose} onClick={() => setRecallOpen(false)} aria-label="Close"><X size={18}/></button><RotateCcw size={23}/><h2 id="recall-title">Recall a bumped ticket</h2><p>Tickets bumped in the last 30 minutes can return to the ready lane.</p><div className={css.recallList}>{recallTickets.map((ticket) => <div key={ticket.id}><span><b>KOT #{ticket.kotNumber}</b><small>{ticket.tableLabel ?? typeLabel[ticket.orderType]} · {ticket.waiterName} · {ticket.servedAt && new Date(ticket.servedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}</small></span><button onClick={() => void sendAction(ticket, "recall")}>Recall</button></div>)}{!recallTickets.length && <div className={css.modalEmpty}>No tickets were bumped in the last 30 minutes.</div>}</div></section></div>}

    {metricsOpen && metrics && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMetricsOpen(false); }}><section className={`${css.modal} ${css.metricsModal}`} role="dialog" aria-modal="true" aria-labelledby="metrics-title"><button className={css.modalClose} onClick={() => setMetricsOpen(false)} aria-label="Close"><X size={18}/></button><Activity size={23}/><h2 id="metrics-title">Kitchen performance · 14 days</h2><p>{metrics.sampleSize} tickets analyzed{metrics.capped ? " (sample capped at 5,000)" : ""}. SLA breaches compare prep time with each order type target.</p><div className={css.metricsGrid}>{metrics.stations.map((stat) => <article key={stat.station}><b>{stat.station}</b><span>{stat.tickets} tickets · {stat.slaBreaches} SLA breaches</span><small>Avg prep {stat.avgPrepSeconds === null ? "—" : `${Math.round(stat.avgPrepSeconds / 60)}m`} · Handoff {stat.avgHandoffSeconds === null ? "—" : `${Math.round(stat.avgHandoffSeconds / 60)}m`}</small></article>)}</div><h3>Peak hour · India time</h3><div className={css.heatmap}>{metrics.hourly.map((hour) => <span key={hour.hour} title={`${String(hour.hour).padStart(2, "0")}:00 · ${hour.tickets} tickets`} className={css.heatCell} data-level={Math.max(1, Math.ceil(hour.tickets / maxHourlyTickets * 10))}>{String(hour.hour).padStart(2, "0")}</span>)}</div><h3>Item prep estimates</h3><div className={css.metricsItems}>{metrics.items.slice(0, 8).map((item) => <span key={item.item}>{item.item}<b>{item.avgPrepSeconds === null ? "—" : `${Math.round(item.avgPrepSeconds / 60)}m`} avg</b></span>)}</div></section></div>}

    {stationSetupOpen && <div className={css.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setStationSetupOpen(false); }}><section className={`${css.modal} ${css.metricsModal}`} role="dialog" aria-modal="true" aria-labelledby="stations-title"><button className={css.modalClose} onClick={() => setStationSetupOpen(false)} aria-label="Close"><X size={18}/></button><Settings2 size={23}/><h2 id="stations-title">Kitchen station routing</h2><p>Choose where new order lines should print and appear. Existing KOTs keep their assigned station.</p>
      {permissions.includes("settings.manage") && <section className={css.columnSettings} aria-label="Kitchen board columns"><h3>Board columns · {stationId === "all" ? "All stations" : snapshot?.stations.find((station) => station.id === stationId)?.name ?? "Selected station"}</h3><p>Choose visible stages and change their left-to-right order. These settings apply to the station selected in the board header.</p><div className={css.columnList}>{defaultKdsColumns.map((state) => { const index = columns.indexOf(state); return <div className={css.columnRow} key={state}><label><input type="checkbox" checked={index >= 0} disabled={savingColumns || (index >= 0 && columns.length === 1)} onChange={(event) => toggleColumn(state, event.target.checked)}/><span><b>{kdsLaneLabels[state]}</b><small>{state === "QUEUED" ? "Waiting to be started" : state === "PREPARING" ? "Being prepared" : "Ready to serve"}</small></span></label><div><button type="button" aria-label={`Move ${kdsLaneLabels[state]} left`} disabled={savingColumns || index <= 0} onClick={() => moveColumn(index, -1)}>↑</button><button type="button" aria-label={`Move ${kdsLaneLabels[state]} right`} disabled={savingColumns || index < 0 || index >= columns.length - 1} onClick={() => moveColumn(index, 1)}>↓</button></div></div>; })}</div></section>}
      <div className={css.createStation}><input value={newStationName} onChange={(event) => setNewStationName(event.target.value)} maxLength={50} placeholder="New station name" aria-label="New station name"/><button disabled={newStationName.trim().length < 2} onClick={() => void createStation()}>Add station</button></div><div className={css.routingList}>{menuItems.map((item) => <label key={item.id}><span><b>{item.name}</b><small>{item.category}</small></span><select value={item.stationId ?? ""} onChange={(event) => void assignStation(item.id, event.target.value)} aria-label={`Station for ${item.name}`}><option value="" disabled>Select station</option>{snapshot?.stations.map((station) => <option value={station.id} key={station.id}>{station.name}</option>)}</select></label>)}</div></section></div>}
  </main>;
}

function playChime(rush: boolean) {
  if (document.visibilityState !== "visible") return;
  const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  const context = new AudioContextConstructor();
  const now = context.currentTime;
  const notes = rush ? [880, 1046, 1320] : [740, 988];
  for (const [index, frequency] of notes.entries()) {
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.frequency.value = frequency; oscillator.type = "sine";
    gain.gain.setValueAtTime(.0001, now + index * .12); gain.gain.exponentialRampToValueAtTime(.08, now + index * .12 + .02); gain.gain.exponentialRampToValueAtTime(.0001, now + index * .12 + .15);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(now + index * .12); oscillator.stop(now + index * .12 + .16);
  }
  window.setTimeout(() => void context.close(), 700);
}
