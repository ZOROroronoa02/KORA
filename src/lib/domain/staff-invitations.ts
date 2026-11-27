export type PendingStaffInvitation = {
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

export function normalizeInvitationEmail(email: string) {
  return email.trim().toLowerCase();
}

/** Active users and distinct live invitations occupy seats under the tenant cap. */
export function occupiedUserSeats(activeEmails: readonly string[], invitations: readonly PendingStaffInvitation[], now = new Date()) {
  const active = new Set(activeEmails.map(normalizeInvitationEmail));
  const reserved = new Set<string>();
  for (const invitation of invitations) {
    const email = normalizeInvitationEmail(invitation.email);
    if (!email || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now || active.has(email)) continue;
    reserved.add(email);
  }
  return active.size + reserved.size;
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
