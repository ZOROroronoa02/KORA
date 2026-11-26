"use client";

import { useEffect, useState } from "react";
import { Save, Store } from "lucide-react";
import { readJson } from "@/lib/client-api";

type Profile = {
  outletName: string;
  businessName: string;
  gstin: string;
  fssaiLicense: string;
  address: { line1: string; line2: string; city: string; state: string; pincode: string };
};

const blank: Profile = { outletName: "", businessName: "", gstin: "", fssaiLicense: "", address: { line1: "", line2: "", city: "", state: "", pincode: "" } };

export function OutletProfileSettings({ outletId, permissions, onNotify }: { outletId: string; permissions: readonly string[]; onNotify: (message: string) => void }) {
  const [profile, setProfile] = useState<Profile>(blank);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const canManage = permissions.includes("settings.manage");

  useEffect(() => {
    let active = true;
    setProfile(blank);
    if (!canManage || !outletId) { setLoading(false); return () => { active = false; }; }
    setLoading(true);
    setError("");
    void readJson<{ profile: Profile }>(`/api/outlet-profile?outletId=${encodeURIComponent(outletId)}`)
      .then(({ profile: value }) => { if (active) setProfile(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Outlet profile could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [outletId, canManage, reload]);

  const updateAddress = (field: keyof Profile["address"], value: string) => setProfile((current) => ({ ...current, address: { ...current.address, [field]: value } }));
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await readJson<{ profile: Profile }>("/api/outlet-profile", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, ...profile }),
      });
      setProfile(result.profile);
      onNotify("Outlet profile saved and recorded in the audit log.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Outlet profile could not be saved.");
    } finally { setSaving(false); }
  };

  return <>
    <div className="page-title-row"><div><p className="eyebrow">YOUR BUSINESS</p><h1>Settings</h1><p className="muted">Restaurant identity and invoice details for this outlet.</p></div></div>
    <section className="card content-card">
    <div className="card-heading"><div><p className="eyebrow">OUTLET DETAILS</p><h2>Restaurant profile</h2><p>These legal and location details are saved for this outlet.</p></div><Store size={17}/></div>
    {!canManage ? <p role="status">Profile editing is available to users with settings.manage.</p> : loading ? <p role="status">Loading outlet profile…</p> : error && !profile.outletName ? <div><p className="form-error" role="alert">{error}</p><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <form className="settings-form" onSubmit={(event) => void save(event)}>
      <label>Business account name<input value={profile.businessName} readOnly aria-describedby="business-name-note"/></label>
      <small id="business-name-note">Shared across this restaurant account; shown for reference.</small>
      <label>Outlet name<input required minLength={2} maxLength={100} value={profile.outletName} onChange={(event) => setProfile((current) => ({ ...current, outletName: event.target.value }))}/></label>
      <div className="form-split"><label>GSTIN<input autoCapitalize="characters" maxLength={15} value={profile.gstin} onChange={(event) => setProfile((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))} placeholder="15-character GSTIN"/></label><label>FSSAI license<input inputMode="numeric" maxLength={14} value={profile.fssaiLicense} onChange={(event) => setProfile((current) => ({ ...current, fssaiLicense: event.target.value.replace(/\D/g, "") }))} placeholder="14 digits"/></label></div>
      <label>Address line 1<input maxLength={120} value={profile.address.line1} onChange={(event) => updateAddress("line1", event.target.value)}/></label>
      <label>Address line 2<input maxLength={120} value={profile.address.line2} onChange={(event) => updateAddress("line2", event.target.value)}/></label>
      <div className="form-split"><label>City<input maxLength={80} value={profile.address.city} onChange={(event) => updateAddress("city", event.target.value)}/></label><label>State<input maxLength={80} value={profile.address.state} onChange={(event) => updateAddress("state", event.target.value)}/></label></div>
      <label>PIN code<input inputMode="numeric" maxLength={6} value={profile.address.pincode} onChange={(event) => updateAddress("pincode", event.target.value.replace(/\D/g, ""))}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={saving}><Save size={15}/>{saving ? " Saving…" : " Save profile"}</button>
    </form>}
    </section>
  </>;
}
