import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;

test('outlet creation enforces plan caps, owner authorization, tenant isolation, and atomic capacity under concurrency', { skip: !enabled, timeout: 120000 }, async () => {
  const prisma = new PrismaClient();
  const tenantIds = [];
  const readJson = async (response) => ({ status: response.status, body: await response.json() });
  const register = async (label) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const result = await readJson(await fetch(`${api}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantName: `${label} ${suffix}`, outletName: 'Main outlet', name: 'Test Owner', email: `owner-${suffix}@example.test`, password: 'KoraOutletPass123!', plan: 'PRO' }),
    }));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    tenantIds.push(result.body.tenant.id);
    return { ...result.body, headers: { authorization: `Bearer ${result.body.accessToken}` }, suffix };
  };
  const createOutlet = (owner, name, extra = {}) => fetch(`${api}/api/outlets`, {
    method: 'POST', headers: { ...owner.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ outletId: owner.outlet.id, name, ...extra }),
  });

  try {
    const owner = await register('Outlet limit');
    assert.equal((await prisma.tenant.findUnique({ where: { id: owner.tenant.id }, select: { plan: true } })).plan, 'FREE', 'client-supplied plan must be ignored during registration');
    const freeLimit = await readJson(await createOutlet(owner, 'Second outlet'));
    assert.equal(freeLimit.status, 409, JSON.stringify(freeLimit.body));
    assert.equal(freeLimit.body.code, 'PLAN_LIMIT_REACHED');
    assert.equal(freeLimit.body.resource, 'outlets');
    assert.equal(await prisma.outlet.count({ where: { tenantId: owner.tenant.id } }), 1, 'rejected request must not leave a partial outlet');

    await prisma.tenant.update({ where: { id: owner.tenant.id }, data: { plan: 'PRO' } });
    const created = await readJson(await createOutlet(owner, 'Bengaluru Airport', { code: 'AIRPORT' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const newOutletId = created.body.outlet.id;
    assert.equal(await prisma.restaurantTable.count({ where: { outletId: newOutletId } }), 10);
    assert.equal(await prisma.station.count({ where: { outletId: newOutletId } }), 1);
    assert.equal(await prisma.menuCategory.count({ where: { outletId: newOutletId } }), 5);
    assert.equal(await prisma.menuItem.count({ where: { tenantId: owner.tenant.id, category: { outletId: newOutletId } } }), 10);
    assert.equal(await prisma.rawMaterial.count({ where: { tenantId: owner.tenant.id, outletId: newOutletId } }), 0, 'inventory must not be copied between outlets');
    assert.equal(await prisma.userOutletRole.count({ where: { userId: owner.user.id, outletId: newOutletId } }), 1, 'creator must have access to the outlet they created');
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId: owner.tenant.id, outletId: newOutletId, action: 'OUTLET_CREATED' } }));

    const menu = await readJson(await fetch(`${api}/api/menu?outletId=${newOutletId}`, { headers: owner.headers }));
    assert.equal(menu.status, 200, JSON.stringify(menu.body));
    assert.ok(menu.body.some((category) => category.items.some((item) => item.name === 'Masala Dosa')));

    const tenantRoles = await prisma.role.findMany({ where: { tenantId: owner.tenant.id, name: 'RESTAURANT_MANAGER' } });
    const manager = await prisma.user.create({ data: { tenantId: owner.tenant.id, name: 'Outlet Manager', email: `manager-${owner.suffix}@example.test`, passwordHash: await hash('KoraManagerPass123!', 4) } });
    await prisma.userOutletRole.create({ data: { userId: manager.id, outletId: owner.outlet.id, roleId: tenantRoles[0].id } });
    const managerLogin = await readJson(await fetch(`${api}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantSlug: owner.tenant.slug, email: manager.email, password: 'KoraManagerPass123!' }),
    }));
    assert.equal(managerLogin.status, 200, JSON.stringify(managerLogin.body));
    const managerHeaders = { authorization: `Bearer ${managerLogin.body.accessToken}`, 'content-type': 'application/json' };
    const managerAttempt = await fetch(`${api}/api/outlets`, { method: 'POST', headers: managerHeaders, body: JSON.stringify({ outletId: owner.outlet.id, name: 'Manager branch' }) });
    assert.equal(managerAttempt.status, 403);
    assert.equal(await prisma.outlet.count({ where: { tenantId: owner.tenant.id } }), 2);

    const otherTenant = await register('Other tenant');
    const crossTenantAttempt = await createOutlet(owner, 'Cross-tenant branch', { outletId: otherTenant.outlet.id });
    assert.equal(crossTenantAttempt.status, 403);
    assert.equal(await prisma.outlet.count({ where: { tenantId: otherTenant.tenant.id } }), 1);

    const remainingSlots = Array.from({ length: 7 }, (_, index) => createOutlet(owner, `Branch ${index + 1}`, { code: `BRANCH_${index + 1}` }));
    const slotResults = await Promise.all(remainingSlots);
    for (const response of slotResults) assert.equal(response.status, 201, await response.text());
    assert.equal(await prisma.outlet.count({ where: { tenantId: owner.tenant.id } }), 9);
    const concurrent = await Promise.all([createOutlet(owner, 'Race branch A', { code: 'RACE_A' }), createOutlet(owner, 'Race branch B', { code: 'RACE_B' })]);
    const statuses = await Promise.all(concurrent.map((response) => response.status));
    assert.deepEqual(statuses.sort(), [201, 409]);
    assert.equal(await prisma.outlet.count({ where: { tenantId: owner.tenant.id } }), 10, 'concurrent requests must not exceed the Pro cap');
  } finally {
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
