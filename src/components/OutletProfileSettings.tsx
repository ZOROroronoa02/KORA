"use client";

import { useEffect, useState } from "react";
import { Save, Store } from "lucide-react";
import { readJson } from "@/lib/client-api";

type Profile = {
  outletName: string;
  businessName: string;
  gstin: string;
  gstProfile: "NOT_REGISTERED" | "STANDARD_RESTAURANT" | "SPECIFIED_PREMISES" | "COMPOSITION";
  gstRateBps: number;
  fssaiLicense: string;
  address: { line1: string; line2: string; city: string; state: string; pincode: string };
};

const blank: Profile = { outletName: "", businessName: "", gstin: "", gstProfile: "NOT_REGISTERED", gstRateBps: 0, fssaiLicense: "", address: { line1: "", line2: "", city: "", state: "", pincode: "" } };

export function OutletProfileSettings({ outletId, permissions, onNotify }: { outletId: string; permissions: readonly string[]; onNotify: (message: string) => void }) {
  const [profile, setProfile] = useState<Profile>(blank);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const canManage = permissions.includes("settings.manage");
  const canManageTax = permissions.includes("tax.profile.manage");

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

  const setTaxProfile = (gstProfile: Profile["gstProfile"]) => setProfile((current) => ({ ...current, gstProfile, gstRateBps: ({ NOT_REGISTERED: 0, STANDARD_RESTAURANT: 500, SPECIFIED_PREMISES: 1800, COMPOSITION: 0 } as const)[gstProfile] }));
  const profileNote = ({
    NOT_REGISTERED: "No GST is added to customer bills. Configure this when the tenant is not GST-registered.",
    STANDARD_RESTAURANT: "Built-in default: 5% for restaurant service outside specified premises; input tax credit is restricted.",
    SPECIFIED_PREMISES: "Built-in default: 18%. Use only when the premises qualifies under current GST rules; input tax credit conditions apply.",
    COMPOSITION: "Issues a Bill of Supply and never adds GST to the customer bill. Composition liability is calculated on turnover, not per order.",
  })[profile.gstProfile];

  return <>
    <div className="page-title-row"><div><p className="eyebrow">YOUR BUSINESS</p><h1>Settings</h1><p className="muted">Outlet details and tenant-shared GST registration for invoices.</p></div></div>
    <section className="card content-card">
    <div className="card-heading"><div><p className="eyebrow">OUTLET DETAILS</p><h2>Restaurant profile</h2><p>GST registration is shared across every outlet in this tenant.</p></div><Store size={17}/></div>
    {!canManage ? <p role="status">Profile editing is available to users with settings.manage.</p> : loading ? <p role="status">Loading outlet profile…</p> : error && !profile.outletName ? <div><p className="form-error" role="alert">{error}</p><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <form className="settings-form" onSubmit={(event) => void save(event)}>
      <label>Business account name<input value={profile.businessName} readOnly aria-describedby="business-name-note"/></label>
      <small id="business-name-note">Shared across this restaurant account; shown for reference.</small>
      <label>Outlet name<input required minLength={2} maxLength={100} value={profile.outletName} onChange={(event) => setProfile((current) => ({ ...current, outletName: event.target.value }))}/></label>
      <div className="form-split"><label>Tenant GSTIN<input autoCapitalize="characters" maxLength={15} value={profile.gstin} disabled={!canManageTax} onChange={(event) => setProfile((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))} placeholder="15-character GSTIN"/></label><label>FSSAI license<input inputMode="numeric" maxLength={14} value={profile.fssaiLicense} onChange={(event) => setProfile((current) => ({ ...current, fssaiLicense: event.target.value.replace(/\D/g, "") }))} placeholder="14 digits"/></label></div>
      <small>One GSTIN is shared by this tenant's outlets. Cross-state outlets require separate registrations and are not supported by this profile.</small>
      <label>GST profile<select value={profile.gstProfile} disabled={!canManageTax} onChange={(event) => setTaxProfile(event.target.value as Profile["gstProfile"])}>
        <option value="NOT_REGISTERED">Not GST registered · Receipt · 0%</option>
        <option value="STANDARD_RESTAURANT">Standard restaurant · Tax Invoice · 5%</option>
        <option value="SPECIFIED_PREMISES">Specified premises · Tax Invoice · 18%</option>
        <option value="COMPOSITION">Composition · Bill of Supply · no GST charged</option>
      </select></label>
      <small>{profileNote}</small>
      {profile.gstProfile !== "NOT_REGISTERED" && profile.gstProfile !== "COMPOSITION" && <label>Default menu GST rate (%)<input type="number" min="0" max="100" step="0.01" value={(profile.gstRateBps / 100).toFixed(2)} disabled={!canManageTax} onChange={(event) => setProfile((current) => ({ ...current, gstRateBps: Math.round(Number(event.target.value) * 100) }))}/></label>}
      {!canManageTax && <small>Only an owner with tax profile permission can change the tenant GST registration or tax profile.</small>}
      <small>Menu prices are tax-exclusive. Confirm the selected regime and rate with your accountant before use.</small>
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
