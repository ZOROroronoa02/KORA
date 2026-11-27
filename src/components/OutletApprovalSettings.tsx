"use client";

import { useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { readJson } from "@/lib/client-api";
import { roleNames, systemRolePermissions } from "@/lib/permissions";
import { Can } from "@/components/Can";

type Settings = {
  discountApprovalThresholdPct: number;
  voidRequiresApproval: boolean;
  kdsSoundEnabled: boolean;
  stockShortagePolicy: "BLOCK" | "ALLOW_NEGATIVE";
  slaMinutesPerOrderType: { DINE_IN: number; TAKEAWAY: number; DELIVERY: number };
};

const defaults: Settings = {
  discountApprovalThresholdPct: 10,
  voidRequiresApproval: false,
  kdsSoundEnabled: true,
  stockShortagePolicy: "BLOCK",
  slaMinutesPerOrderType: { DINE_IN: 15, TAKEAWAY: 15, DELIVERY: 20 },
};

export function OutletApprovalSettings({ outletId, permissions, cloudMode, demoRole, setDemoRole, onNotify }: {
  outletId: string;
  permissions: readonly string[];
  cloudMode: boolean;
  demoRole: keyof typeof systemRolePermissions;
  setDemoRole: (role: keyof typeof systemRolePermissions) => void;
  onNotify: (message: string) => void;
}) {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const canManage = permissions.includes("settings.manage");

  useEffect(() => {
    if (!cloudMode || !outletId || !canManage) return;
    let active = true;
    setLoading(true);
    void readJson<{ settings: Partial<Settings> & { slaMinutesPerOrderType?: Partial<Settings["slaMinutesPerOrderType"]> } }>(`/api/outlet-settings?outletId=${encodeURIComponent(outletId)}`)
      .then(({ settings: value }) => {
        if (!active) return;
        setSettings({
          discountApprovalThresholdPct: typeof value.discountApprovalThresholdPct === "number" ? value.discountApprovalThresholdPct : defaults.discountApprovalThresholdPct,
          voidRequiresApproval: value.voidRequiresApproval === true,
          kdsSoundEnabled: value.kdsSoundEnabled !== false,
          stockShortagePolicy: value.stockShortagePolicy === "ALLOW_NEGATIVE" ? "ALLOW_NEGATIVE" : "BLOCK",
          slaMinutesPerOrderType: { ...defaults.slaMinutesPerOrderType, ...value.slaMinutesPerOrderType },
        });
      })
      .catch((error) => { if (active) onNotify(error instanceof Error ? error.message : "Outlet settings could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [outletId, cloudMode, canManage]);

  const save = async () => {
    setSaving(true);
    try {
      await readJson("/api/outlet-settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, ...settings }) });
      onNotify("Outlet approval, inventory, and KDS settings saved.");
    } catch (error) { onNotify(error instanceof Error ? error.message : "Outlet settings could not be saved."); }
    finally { setSaving(false); }
  };

  return <>
    {!cloudMode && <section className="card content-card"><div className="card-heading"><div><h2>Demo role switcher</h2><p>Preview the role-based navigation and dashboards locally.</p></div><ShieldCheck size={17}/></div><label className="role-select-label">Preview as<select value={demoRole} onChange={(event) => setDemoRole(event.target.value as keyof typeof systemRolePermissions)}>{roleNames.map((role) => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</select></label></section>}
    {cloudMode && <Can permissions={permissions} permission="settings.manage">{canManage && <section className="card content-card"><div className="card-heading"><div><h2>Outlet approvals & service targets</h2><p>{loading ? "Loading saved outlet policy…" : "Sensitive overrides are recorded with the approving manager."}</p></div><ShieldCheck size={17}/></div><div className="settings-form"><label>Discount approval threshold (%)<input type="number" min="0" max="100" step="0.5" value={settings.discountApprovalThresholdPct} onChange={(event) => setSettings((current) => ({ ...current, discountApprovalThresholdPct: Number(event.target.value) }))}/></label><div className="setting-option"><span><b>Require a manager PIN to void orders</b><small>Cashiers must obtain a different manager’s PIN.</small></span><input type="checkbox" checked={settings.voidRequiresApproval} onChange={(event) => setSettings((current) => ({ ...current, voidRequiresApproval: event.target.checked }))}/></div><div className="setting-option"><span><b>Kitchen ticket sounds</b><small>Sound is played only after the operator interacts with the KDS.</small></span><input type="checkbox" checked={settings.kdsSoundEnabled} onChange={(event) => setSettings((current) => ({ ...current, kdsSoundEnabled: event.target.checked }))}/></div><div className="setting-option"><span><b>Sales when recipe stock is short</b><small>New outlets block these sales. Allowing them records negative stock and an audited shortage.</small></span><select value={settings.stockShortagePolicy} onChange={(event) => setSettings((current) => ({ ...current, stockShortagePolicy: event.target.value as Settings["stockShortagePolicy"] }))}><option value="BLOCK">Block online sale</option><option value="ALLOW_NEGATIVE">Allow negative with audit</option></select></div><p className="settings-subhead">Kitchen SLA minutes</p><div className="form-split">{(["DINE_IN", "TAKEAWAY", "DELIVERY"] as const).map((type) => <label key={type}>{type.replace("_", " ")}<input type="number" min="1" max="240" step="1" value={settings.slaMinutesPerOrderType[type]} onChange={(event) => setSettings((current) => ({ ...current, slaMinutesPerOrderType: { ...current.slaMinutesPerOrderType, [type]: Number(event.target.value) } }))}/></label>)}</div><button className="primary-button" disabled={loading || saving} onClick={() => void save()}><Save size={15}/>{saving ? " Saving…" : " Save outlet policy"}</button></div></section>}</Can>}
    {cloudMode && !canManage && <section className="card content-card"><p>Outlet policy is available to users with settings.manage.</p></section>}
  </>;
}
