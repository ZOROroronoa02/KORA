import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);

test('outlet profile API enforces outlet authorization, validates fields, and audits changes', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  let foreignTenantId;
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const registerResponse = await fetch(`${api}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1` },
      body: JSON.stringify({ tenantName: `Profile Test ${suffix}`, outletName: 'Primary Outlet', name: 'Profile Owner', email: `profile-${suffix}@example.test`, password: 'ProfileTest123!Secure' }),
    });
    const registered = await registerResponse.json();
    assert.equal(registerResponse.status, 201, JSON.stringify(registered));
    tenantId = registered.tenant.id;
    const ownerHeaders = { authorization: `Bearer ${registered.accessToken}`, 'content-type': 'application/json' };

    const anonymous = await fetch(`${api}/api/outlet-profile?outletId=${registered.outlet.id}`);
    assert.equal(anonymous.status, 401);

    const secondOutlet = await prisma.outlet.create({ data: { tenantId, name: 'Unassigned Outlet', code: `P-${suffix}` } });
    const forbiddenOutlet = await fetch(`${api}/api/outlet-profile?outletId=${secondOutlet.id}`, { headers: ownerHeaders });
    assert.equal(forbiddenOutlet.status, 403, 'an owner without an assignment to another outlet cannot read its profile');

    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'CASHIER' } } });
    const cashier = await prisma.user.create({ data: { tenantId, name: 'Profile Cashier', email: `cashier-${suffix}@example.test`, passwordHash: await hash('CashierTest123!Secure', 4) } });
    await prisma.userOutletRole.create({ data: { userId: cashier.id, outletId: registered.outlet.id, roleId: cashierRole.id } });
    const cashierToken = await fetch(`${api}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8:${suffix.slice(1, 5)}:${suffix.slice(5, 9)}::2` },
      body: JSON.stringify({ tenantSlug: registered.tenant.slug, email: cashier.email, password: 'CashierTest123!Secure' }),
    });
    const cashierLogin = await cashierToken.json();
    assert.equal(cashierToken.status, 200, JSON.stringify(cashierLogin));
    const forbiddenUpdate = await fetch(`${api}/api/outlet-profile`, {
      method: 'PATCH', headers: { authorization: `Bearer ${cashierLogin.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registered.outlet.id, outletName: 'Tampered', gstin: '', fssaiLicense: '', address: {} }),
    });
    assert.equal(forbiddenUpdate.status, 403, 'cashiers cannot update legal outlet details');

    foreignTenantId = (await prisma.tenant.create({ data: { name: `Foreign ${suffix}`, slug: `foreign-${suffix}` } })).id;
    const foreignOutlet = await prisma.outlet.create({ data: { tenantId: foreignTenantId, name: 'Foreign Outlet', code: 'FOREIGN' } });
    const crossTenant = await fetch(`${api}/api/outlet-profile?outletId=${foreignOutlet.id}`, { headers: ownerHeaders });
    assert.equal(crossTenant.status, 403, 'tenant users cannot read another tenant outlet');

    const getProfile = async (outletId) => {
      const response = await fetch(`${api}/api/outlet-profile?outletId=${outletId}`, { headers: ownerHeaders });
      return { response, body: await response.json() };
    };
    const initial = await getProfile(registered.outlet.id);
    assert.equal(initial.response.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.profile.outletName, 'Primary Outlet');
    assert.equal(initial.body.profile.businessName, registered.tenant.name);

    const profile = {
      outletId: registered.outlet.id,
      outletName: 'Indiranagar Dining Room',
      gstin: '29ABCDE1234F1Z5',
      fssaiLicense: '11223344556677',
      address: { line1: '12 Main Road', line2: 'Second Floor', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
    };
    const savedResponse = await fetch(`${api}/api/outlet-profile`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify(profile) });
    const saved = await savedResponse.json();
    assert.equal(savedResponse.status, 200, JSON.stringify(saved));
    assert.deepEqual(saved.profile, {
      outletName: profile.outletName,
      businessName: registered.tenant.name,
      gstin: profile.gstin,
      fssaiLicense: profile.fssaiLicense,
      address: profile.address,
    });
    const audit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: registered.outlet.id, action: 'OUTLET_PROFILE_CHANGED', entityId: registered.outlet.id } });
    assert.equal(audit?.userId, registered.user.id);
    assert.equal(audit?.after?.gstin, profile.gstin);
    assert.equal(audit?.before?.outletName, 'Primary Outlet');

    const invalidGstin = await fetch(`${api}/api/outlet-profile`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ ...profile, gstin: 'not-a-gstin' }) });
    assert.equal(invalidGstin.status, 400);
    const invalidPin = await fetch(`${api}/api/outlet-profile`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ ...profile, address: { ...profile.address, pincode: '12' } }) });
    assert.equal(invalidPin.status, 400);
    assert.equal((await getProfile(registered.outlet.id)).body.profile.gstin, profile.gstin, 'invalid requests must not partially change the profile');

    const siblingOutlet = await prisma.outlet.findUniqueOrThrow({ where: { id: secondOutlet.id } });
    assert.equal(siblingOutlet.name, 'Unassigned Outlet', 'one outlet profile update must leave sibling outlets unchanged');
  } finally {
    if (foreignTenantId) await prisma.tenant.deleteMany({ where: { id: foreignTenantId } }).catch(() => undefined);
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
