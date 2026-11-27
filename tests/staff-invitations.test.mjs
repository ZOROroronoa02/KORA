import test from 'node:test';
import assert from 'node:assert/strict';
import { isInvitationToken, normalizeInvitationEmail, occupiedUserSeats } from '../src/lib/domain/staff-invitations.ts';

test('invitation seat reservations deduplicate pending emails and ignore expired, revoked, accepted, and active-user invites', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const invitation = (email, options = {}) => ({
    email,
    expiresAt: options.expiresAt ?? new Date('2026-11-28T12:00:00.000Z'),
    acceptedAt: options.acceptedAt ?? null,
    revokedAt: options.revokedAt ?? null,
  });
  assert.equal(occupiedUserSeats(['owner@example.test'], [
    invitation(' STAFF@example.test '), invitation('staff@example.test'),
    invitation('expired@example.test', { expiresAt: new Date('2026-11-27T11:59:59.000Z') }),
    invitation('revoked@example.test', { revokedAt: now }),
    invitation('accepted@example.test', { acceptedAt: now }),
    invitation('owner@example.test'),
  ], now), 2);
});

test('invitation email normalization and bearer token shape are strict', () => {
  assert.equal(normalizeInvitationEmail('  STAFF+KORA@Example.Test '), 'staff+kora@example.test');
  assert.equal(isInvitationToken('a'.repeat(43)), true);
  assert.equal(isInvitationToken('a'.repeat(42)), false);
  assert.equal(isInvitationToken(`${'a'.repeat(42)}.`), false);
  assert.equal(isInvitationToken(null), false);
});
