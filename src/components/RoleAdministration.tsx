"use client";

import { useEffect, useState } from "react";
import { CopyPlus, RefreshCw, Save, ShieldCheck, Users } from "lucide-react";
import { readJson } from "@/lib/client-api";

type Role = { id: string; name: string; description: string; isSystem: boolean; permissions: string[]; assignedUserCount: number };
type Permission = { id: string; key: string; description: string };
type Staff = { user: { id: string; name: string; email: string; active: boolean; hasApprovalPin: boolean }; roles: Array<{ id: string; name: string }>; permissions: string[] };
type Invitation = { id: string; email: string; expiresAt: string; createdAt: string; role: { id: string; name: string }; createdBy: { name: string } };

export function RoleAdministration({ outletId, permissions, onNotify }: { outletId: string; permissions: readonly string[]; onNotify: (message: string) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissionRows, setPermissionRows] = useState<Permission[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selectedRole, setSelectedRole] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [draftPermissions, setDraftPermissions] = useState<string[]>([]);
  const [cloneSourceId, setCloneSourceId] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [busy, setBusy] = useState(false);
  const [approvalPin, setApprovalPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  const [oneTimeInviteUrl, setOneTimeInviteUrl] = useState("");
  const canManageRoles = permissions.includes("roles.manage");
  const canManageStaff = permissions.includes("staff.manage");

  const reload = async () => {
    const results = await Promise.allSettled([
      canManageRoles ? readJson<{ roles: Role[]; permissions: Permission[] }>(`/api/admin/roles?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve(null),
      canManageStaff ? readJson<{ staff: Staff[] }>(`/api/admin/staff?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve(null),
      canManageRoles ? readJson<{ invitations: Invitation[] }>(`/api/admin/invitations?outletId=${encodeURIComponent(outletId)}`) : Promise.resolve(null),
    ]);
    const roleResult = results[0];
    if (roleResult.status === "fulfilled" && roleResult.value) {
      setRoles(roleResult.value.roles);
      setPermissionRows(roleResult.value.permissions);
      setSelectedRole((current) => roleResult.value!.roles.some((role) => role.id === current) ? current : roleResult.value!.roles[0]?.id ?? "");
      setInviteRoleId((current) => roleResult.value!.roles.some((role) => role.id === current && role.name !== "SUPER_ADMIN") ? current : roleResult.value!.roles.find((role) => role.name === "CASHIER")?.id ?? roleResult.value!.roles.find((role) => role.name !== "SUPER_ADMIN")?.id ?? "");
    }
    const staffResult = results[1];
    if (staffResult.status === "fulfilled" && staffResult.value) {
      setStaff(staffResult.value.staff);
      setSelectedUser((current) => staffResult.value!.staff.some((person) => person.user.id === current) ? current : staffResult.value!.staff[0]?.user.id ?? "");
    }
    const invitationResult = results[2];
    if (invitationResult.status === "fulfilled" && invitationResult.value) setInvitations(invitationResult.value.invitations);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) onNotify("Some team data could not be loaded. Refresh or verify your permissions.");
  };

  useEffect(() => { void reload(); }, [outletId, canManageRoles, canManageStaff]);
  useEffect(() => { setOneTimeInviteUrl(""); setInviteEmail(""); }, [outletId]);

  const activeRole = roles.find((role) => role.id === selectedRole);
  const activeStaff = staff.find((person) => person.user.id === selectedUser);
  useEffect(() => {
    if (activeRole) setDraftPermissions(activeRole.permissions);
  }, [activeRole?.id, activeRole?.permissions.join("|")]);
  useEffect(() => {
    if (activeStaff) setSelectedRoleIds(activeStaff.roles.map((role) => role.id));
  }, [activeStaff?.user.id, activeStaff?.roles.map((role) => role.id).join("|")]);

  const saveRoles = async () => {
    if (!selectedUser || !selectedRoleIds.length) return;
    setBusy(true);
    try {
      await readJson(`/api/admin/staff?outletId=${encodeURIComponent(outletId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, userId: selectedUser, roleIds: selectedRoleIds }) });
      onNotify("Outlet roles updated and access cache cleared.");
      await reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Role assignment failed."); }
    finally { setBusy(false); }
  };

  const createInvitation = async () => {
    if (!inviteEmail.trim() || !inviteRoleId) return;
    setBusy(true);
    setOneTimeInviteUrl("");
    try {
      const result = await readJson<{ assigned?: boolean; role?: string; invitation?: { url: string } }>("/api/admin/invitations", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ outletId, email: inviteEmail.trim(), roleId: inviteRoleId }),
      });
      setInviteEmail("");
      if (result.assigned) onNotify(`Existing staff account assigned ${result.role} access.`);
      else if (result.invitation?.url) {
        setOneTimeInviteUrl(result.invitation.url);
        onNotify("Invitation created. Copy and share this one-time link securely; it is shown only once.");
      }
      await reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Invitation could not be created."); }
    finally { setBusy(false); }
  };

  const revokeInvitation = async (invitationId: string) => {
    setBusy(true);
    try {
      await readJson("/api/admin/invitations", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, invitationId }) });
      onNotify("Invitation revoked; its seat is available again.");
      await reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Invitation could not be revoked."); }
    finally { setBusy(false); }
  };

  const copyInvitation = async () => {
    try { await navigator.clipboard.writeText(oneTimeInviteUrl); onNotify("One-time invitation link copied."); }
    catch { onNotify("Could not access the clipboard. Select and copy the invitation link manually."); }
  };

  const cloneRole = async () => {
    if (!cloneSourceId || cloneName.trim().length < 2) return;
    setBusy(true);
    try {
      await readJson(`/api/admin/roles?outletId=${encodeURIComponent(outletId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, sourceRoleId: cloneSourceId, name: cloneName.trim() }) });
      setCloneName("");
      onNotify("Custom role cloned. Review its permissions before assignment.");
      await reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Role could not be cloned."); }
    finally { setBusy(false); }
  };

  const savePermissions = async () => {
    if (!activeRole || activeRole.isSystem) return;
    setBusy(true);
    try {
      await readJson(`/api/admin/roles?outletId=${encodeURIComponent(outletId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, roleId: activeRole.id, permissions: draftPermissions }) });
      onNotify("Role permissions updated; affected outlet access cache cleared.");
      await reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Permissions could not be saved."); }
    finally { setBusy(false); }
  };

  const saveApprovalPin = async () => {
    setBusy(true);
    try {
      await readJson("/api/staff/approval-pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outletId, pin: approvalPin, currentPin: currentPin || undefined }) });
      setApprovalPin(""); setCurrentPin("");
      onNotify("Your approval PIN was updated. The PIN itself is never stored in clear text.");
      await reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "Approval PIN could not be updated."); }
    finally { setBusy(false); }
  };

  return <>
    <div className="page-title-row">
      <div><p className="eyebrow">PEOPLE & ACCESS</p><h1>Your team</h1><p className="muted">Role changes are audited and take effect on the next request.</p></div>
      <button className="secondary-button" onClick={() => void reload()}><RefreshCw size={15}/> Refresh</button>
    </div>
    {!canManageStaff && <div className="card content-card"><p>You do not have permission to view team members.</p></div>}
    {canManageStaff && <div className="card content-card">
      <div className="table-toolbar"><div><h2 className="section-title"><Users size={17}/> Outlet team <span className="count-bubble">{staff.length}</span></h2></div><span className="muted">{staff.filter((person) => person.user.active).length} active accounts</span></div>
      {staff.length === 0 ? <div className="empty-state"><Users size={23}/><b>No users are assigned to this outlet</b><span>Invite a staff member below to create an account and assign their first outlet role.</span></div> : <div className="role-admin-grid">
        <section className="role-admin-users"><h3>Staff member</h3><div className="role-user-list">{staff.map((person) => <button type="button" key={person.user.id} className={selectedUser === person.user.id ? "selected" : ""} onClick={() => setSelectedUser(person.user.id)}><span className="avatar avatar-moss">{person.user.name.slice(0, 1).toUpperCase()}</span><span><b>{person.user.name}</b><small>{person.user.email}</small><small>{person.roles.map((role) => role.name).join(" · ") || "No role"}</small></span></button>)}</div></section>
        <section className="role-admin-detail"><h3>Effective outlet access</h3>{activeStaff && <><p><b>{activeStaff.user.name}</b> · {activeStaff.user.active ? "Active" : "Inactive"}</p>
          <div className="role-choice-grid">{roles.map((role) => <label key={role.id}><input type="checkbox" checked={selectedRoleIds.includes(role.id)} disabled={!canManageRoles || busy} onChange={(event) => setSelectedRoleIds((current) => event.target.checked ? [...new Set([...current, role.id])] : current.filter((id) => id !== role.id))}/><span>{role.name}</span></label>)}</div>
          {canManageRoles && <button className="primary-button" disabled={busy || !selectedRoleIds.length} onClick={() => void saveRoles()}><Save size={15}/> Save outlet roles</button>}
          <div className="effective-permissions"><b>Effective permissions · union of selected roles</b><div>{activeStaff.permissions.map((permission) => <code key={permission}>{permission}</code>)}</div></div>
        </>}</section>
      </div>}
    </div>}
    {canManageRoles && <section className="card content-card staff-invitations-card">
      <div className="card-heading"><div><h2>Invite staff</h2><p>Invitations reserve a plan seat for 72 hours. The account holder sets their own password.</p></div><Users size={17}/></div>
      <div className="staff-invitation-form"><label>Email address<input type="email" autoComplete="email" maxLength={254} value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="staff@restaurant.in"/></label><label>Outlet role<select value={inviteRoleId} onChange={(event) => setInviteRoleId(event.target.value)}><option value="">Choose a role</option>{roles.filter((role) => role.name !== "SUPER_ADMIN").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><button className="primary-button" type="button" disabled={busy || !inviteEmail.trim() || !inviteRoleId} onClick={() => void createInvitation()}>Create invitation</button></div>
      {oneTimeInviteUrl && <div className="staff-invitation-once" role="status"><b>Copy this link now</b><p>The raw link is not stored or shown again after this screen closes.</p><div><input aria-label="One-time invitation link" readOnly value={oneTimeInviteUrl} onFocus={(event) => event.currentTarget.select()}/><button className="secondary-button" type="button" onClick={() => void copyInvitation()}>Copy link</button></div></div>}
      <div className="staff-invitation-list">{invitations.length ? invitations.map((invitation) => <div className="staff-invitation-row" key={invitation.id}><span><b>{invitation.email}</b><small>{invitation.role.name} · expires {new Date(invitation.expiresAt).toLocaleString()}</small></span><button className="secondary-button" type="button" disabled={busy} onClick={() => void revokeInvitation(invitation.id)}>Revoke</button></div>) : <p className="staff-invitation-empty">No pending invitations for this outlet.</p>}</div>
    </section>}
    {canManageRoles && <div className="role-admin-grid">
      <section className="card content-card"><div className="card-heading"><div><h2>Clone a system role</h2><p>Start with a safe template, then tune a custom role.</p></div><CopyPlus size={17}/></div><div className="form-split"><label>Template<select value={cloneSourceId} onChange={(event) => setCloneSourceId(event.target.value)}><option value="">Choose a role</option>{roles.filter((role) => role.isSystem && role.name !== "SUPER_ADMIN").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><label>Custom role name<input value={cloneName} maxLength={60} onChange={(event) => setCloneName(event.target.value)} placeholder="e.g. Senior cashier"/></label></div><button className="secondary-button" disabled={busy || !cloneSourceId || cloneName.trim().length < 2} onClick={() => void cloneRole()}><CopyPlus size={15}/> Create custom role</button></section>
      <section className="card content-card"><div className="card-heading"><div><h2>Permission matrix</h2><p>{activeRole?.isSystem ? "System role defaults are locked; clone to customize." : activeRole?.name ?? "Select a role"}</p></div><ShieldCheck size={17}/></div><label className="role-select-label">Role<select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)}>{roles.filter((role) => role.name !== "SUPER_ADMIN").map((role) => <option value={role.id} key={role.id}>{role.name}{role.isSystem ? " · system" : " · custom"}</option>)}</select></label><div className="permission-matrix">{permissionRows.map((permission) => <label key={permission.key} title={permission.description}><input type="checkbox" checked={draftPermissions.includes(permission.key)} disabled={!activeRole || activeRole.isSystem || busy} onChange={(event) => setDraftPermissions((current) => event.target.checked ? [...new Set([...current, permission.key])] : current.filter((key) => key !== permission.key))}/><span><b>{permission.key}</b><small>{permission.description}</small></span></label>)}</div><button className="primary-button" disabled={busy || !activeRole || activeRole.isSystem} onClick={() => void savePermissions()}><Save size={15}/> Save permissions</button></section>
    </div>}
    {(permissions.includes("bills.discount.approve") || permissions.includes("bills.void")) && <section className="card content-card approval-pin-card"><div className="card-heading"><div><h2>Manager approval PIN</h2><p>Set a personal PIN for high discounts and configured void approvals.</p></div><ShieldCheck size={17}/></div><div className="form-split"><label>Current PIN, if already set<input type="password" inputMode="numeric" autoComplete="current-password" value={currentPin} onChange={(event) => setCurrentPin(event.target.value)} placeholder="Current PIN"/></label><label>New PIN (4–8 digits)<input type="password" inputMode="numeric" autoComplete="new-password" value={approvalPin} onChange={(event) => setApprovalPin(event.target.value)} placeholder="New approval PIN" maxLength={8}/></label></div><button className="secondary-button" disabled={busy || !/^\d{4,8}$/.test(approvalPin)} onClick={() => void saveApprovalPin()}><Save size={15}/> Save personal PIN</button></section>}
  </>;
}
