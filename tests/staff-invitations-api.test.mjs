import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;

test('staff invitation API enforces owner access, tenant isolation, seat reservations, replay protection, and concurrent caps', { skip: !enabled, timeout: 90000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  let secondTenantId;
  const json = async (response) => ({ status: response.status, body: await response.json() });
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  const register = async (label, suffix) => json(await fetch(`${api}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
    body: JSON.stringify({ tenantName: `${label} ${suffix}`, outletName: 'Main', name: `${label} Owner`, email: `${label.toLowerCase().replace(/\s+/g, '-')}-${suffix}@example.test`, password: 'KoraInvitationPass123!' }),
  }));
  const issue = (token, outletId, roleId, email) => fetch(`${api}/api/admin/invitations`, {
    method: 'POST', headers: { ...auth(token), 'content-type': 'application/json', 'x-forwarded-for': testIp },
    body: JSON.stringify({ outletId, roleId, email }),
  });

  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = await register('Invitation', suffix);
    assert.equal(owner.status, 201, JSON.stringify(owner.body));
    tenantId = owner.body.tenant.id;
    const outletId = owner.body.outlet.id;
    const ownerToken = owner.body.accessToken;
    const cashier = await prisma.role.findFirst({ where: { tenantId, name: 'CASHIER' }, select: { id: true } });
    const managerRole = await prisma.role.findFirst({ where: { tenantId, name: 'RESTAURANT_MANAGER' }, select: { id: true } });
    assert.ok(cashier && managerRole);

    const freeRejected = await json(await issue(ownerToken, outletId, cashier.id, `free-${suffix}@example.test`));
    assert.equal(freeRejected.status, 409, JSON.stringify(freeRejected.body));
    assert.equal(await prisma.staffInvitation.count({ where: { tenantId } }), 0);

    const crossOriginResolve = await fetch(`${api}/api/auth/invitations/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'x-forwarded-for': testIp }, body: JSON.stringify({ token: 'A'.repeat(43) }),
    });
    const crossOriginAccept = await fetch(`${api}/api/auth/invitations/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'x-forwarded-for': testIp }, body: JSON.stringify({ token: 'A'.repeat(43), name: 'Test User', password: 'KoraNewStaffPass123!' }),
    });
    assert.equal(crossOriginResolve.status, 403);
    assert.equal(crossOriginAccept.status, 403);

    await prisma.tenant.update({ where: { id: tenantId }, data: { plan: 'PRO' } });
    const created = await json(await issue(ownerToken, outletId, cashier.id, `invitee-${suffix}@example.test`));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.assigned, false);
    const token = new URL(created.body.invitation.url).hash.slice(1);
    const savedInvite = await prisma.staffInvitation.findUnique({ where: { id: created.body.invitation.id } });
    assert.ok(savedInvite);
    assert.notEqual(savedInvite.tokenHash, token, 'only the token hash must be stored');
    assert.equal(savedInvite.tokenHash.length, 64);
    assert.ok(savedInvite.expiresAt > new Date());

    const listedResponse = await fetch(`${api}/api/admin/invitations?outletId=${encodeURIComponent(outletId)}`, { headers: auth(ownerToken) });
    const listedText = await listedResponse.text();
    assert.equal(listedResponse.status, 200);
    assert.equal(listedText.includes(token), false, 'pending list must never return the bearer token');
    assert.equal(listedText.includes('tokenHash'), false, 'pending list must never return token hashes');

    const resolved = await json(await fetch(`${api}/api/auth/invitations/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp }, body: JSON.stringify({ token }),
    }));
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.invitation.email, `invitee-${suffix}@example.test`);
    assert.equal(JSON.stringify(resolved.body).includes(token), false);

    const accepted = await fetch(`${api}/api/auth/invitations/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ token, name: 'Invited Cashier', password: 'KoraNewStaffPass123!' }),
    });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 201, JSON.stringify(acceptedBody));
    assert.equal(acceptedBody.user.email, `invitee-${suffix}@example.test`);
    assert.match(accepted.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.equal(await prisma.user.count({ where: { tenantId, email: acceptedBody.user.email } }), 1);
    assert.equal(await prisma.userOutletRole.count({ where: { userId: acceptedBody.user.id, outletId, roleId: cashier.id } }), 1);
    assert.ok(await prisma.staffInvitation.findFirst({ where: { id: created.body.invitation.id, acceptedAt: { not: null } } }));
    assert.equal((await json(await fetch(`${api}/api/auth/invitations/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp }, body: JSON.stringify({ token }) }))).status, 404);
    const replay = await json(await fetch(`${api}/api/auth/invitations/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ token, name: 'Replay Attempt', password: 'KoraNewStaffPass123!' }),
    }));
    assert.equal(replay.status, 404);

    const second = await json(await issue(ownerToken, outletId, cashier.id, `revoke-${suffix}@example.test`));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const secondToken = new URL(second.body.invitation.url).hash.slice(1);
    const revoked = await json(await fetch(`${api}/api/admin/invitations`, {
      method: 'DELETE', headers: { ...auth(ownerToken), 'content-type': 'application/json' }, body: JSON.stringify({ outletId, invitationId: second.body.invitation.id }),
    }));
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal((await json(await fetch(`${api}/api/auth/invitations/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp }, body: JSON.stringify({ token: secondToken }) }))).status, 404);

    const managerEmail = `manager-${suffix}@example.test`;
    const manager = await prisma.user.create({ data: { tenantId, email: managerEmail, name: 'Test Manager', passwordHash: await hash('KoraManagerPass123!', 4) } });
    await prisma.userOutletRole.create({ data: { userId: manager.id, outletId, roleId: managerRole.id } });
    const managerLogin = await json(await fetch(`${api}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantSlug: owner.body.tenant.slug, email: managerEmail, password: 'KoraManagerPass123!' }),
    }));
    assert.equal(managerLogin.status, 200);
    const existingUserAssignment = await json(await issue(ownerToken, outletId, cashier.id, managerEmail));
    assert.equal(existingUserAssignment.status, 200, JSON.stringify(existingUserAssignment.body));
    assert.equal(existingUserAssignment.body.assigned, true);
    assert.equal(await prisma.staffInvitation.count({ where: { tenantId, email: managerEmail } }), 0);
    assert.equal(await prisma.userOutletRole.count({ where: { userId: manager.id, outletId, roleId: cashier.id } }), 1);
    assert.equal((await issue(managerLogin.body.accessToken, outletId, cashier.id, `denied-${suffix}@example.test`)).status, 403);

    const otherOwner = await register('Other tenant', suffix);
    assert.equal(otherOwner.status, 201, JSON.stringify(otherOwner.body));
    secondTenantId = otherOwner.body.tenant.id;
    assert.equal((await fetch(`${api}/api/admin/invitations?outletId=${encodeURIComponent(otherOwner.body.outlet.id)}`, { headers: auth(ownerToken) })).status, 403);
    const otherCashier = await prisma.role.findFirst({ where: { tenantId: secondTenantId, name: 'CASHIER' }, select: { id: true } });
    assert.ok(otherCashier);
    assert.equal((await json(await issue(ownerToken, outletId, otherCashier.id, `cross-role-${suffix}@example.test`))).status, 404);

    await prisma.tenant.update({ where: { id: tenantId }, data: { plan: 'PLUS' } });
    for (let index = 0; index < 6; index += 1) {
      await prisma.user.create({ data: { tenantId, email: `seat-${index}-${suffix}@example.test`, name: `Seat ${index}`, passwordHash: 'test-hash' } });
    }
    const raced = await Promise.all([
      issue(ownerToken, outletId, cashier.id, `last-a-${suffix}@example.test`).then(json),
      issue(ownerToken, outletId, cashier.id, `last-b-${suffix}@example.test`).then(json),
    ]);
    assert.deepEqual(raced.map((result) => result.status).sort(), [201, 409]);
    const activeUsers = await prisma.user.count({ where: { tenantId, active: true } });
    const pendingEmails = new Set((await prisma.staffInvitation.findMany({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { email: true } })).map((item) => item.email));
    assert.equal(activeUsers + pendingEmails.size, 10);
  } finally {
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    if (secondTenantId) await prisma.tenant.deleteMany({ where: { id: secondTenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
