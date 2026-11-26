import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;

test('RBAC API: owner boundaries, manager PIN approvals, redaction, and cache invalidation', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  const readJson = async (response) => {
    const body = await response.json();
    return { status: response.status, body };
  };
  const headersFor = (token) => ({ authorization: `Bearer ${token}` });
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const registration = await readJson(await fetch(`${api}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantName: `RBAC ${suffix}`, outletName: 'Main outlet', name: 'Test Owner', email: `owner-${suffix}@example.test`, password: 'KoraRBACPass123!' }),
    }));
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    tenantId = registration.body.tenant.id;
    const { outlet, tenant, user } = registration.body;
    const ownerHeaders = headersFor(registration.body.accessToken);
    const session = await readJson(await fetch(`${api}/api/auth/me`, { headers: ownerHeaders }));
    assert.equal(session.status, 200);
    assert.equal(session.body.outlets[0].permissions.includes('orders.create'), false);
    assert.equal(session.body.outlets[0].permissions.includes('roles.manage'), true);

    const forbiddenOwnerOrder = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, clientMutationId: `owner-forbidden-${suffix}`, type: 'Takeaway', items: [{ menuItemId: 'not-used', quantity: 1 }] }),
    });
    assert.equal(forbiddenOwnerOrder.status, 403);

    const systemRoles = await prisma.role.findMany({ where: { tenantId, name: { in: ['RESTAURANT_MANAGER', 'CASHIER', 'WAITER'] } } });
    const roleByName = new Map(systemRoles.map((role) => [role.name, role]));
    const makeStaff = async (label, roleName) => {
      const email = `${label}-${suffix}@example.test`;
      const password = `Kora${label}Pass123!`;
      const staff = await prisma.user.create({ data: { tenantId, name: label, email, passwordHash: await hash(password, 4) } });
      await prisma.userOutletRole.create({ data: { userId: staff.id, outletId: outlet.id, roleId: roleByName.get(roleName).id } });
      const login = await readJson(await fetch(`${api}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
        body: JSON.stringify({ tenantSlug: tenant.slug, email, password }),
      }));
      assert.equal(login.status, 200, JSON.stringify(login.body));
      return { staff, headers: headersFor(login.body.accessToken) };
    };
    const manager = await makeStaff('manager', 'RESTAURANT_MANAGER');
    const cashier = await makeStaff('cashier', 'CASHIER');
    const waiter = await makeStaff('waiter', 'WAITER');

    const managerRoleAdmin = await fetch(`${api}/api/admin/roles?outletId=${outlet.id}`, { headers: manager.headers });
    assert.equal(managerRoleAdmin.status, 403, 'manager must not administer roles');
    const managerPin = await readJson(await fetch(`${api}/api/staff/approval-pin`, {
      method: 'POST', headers: { ...manager.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, pin: '4826' }),
    }));
    assert.equal(managerPin.status, 200, JSON.stringify(managerPin.body));

    const menuResponse = await readJson(await fetch(`${api}/api/menu?outletId=${outlet.id}`, { headers: cashier.headers }));
    assert.equal(menuResponse.status, 200);
    const menuItem = menuResponse.body.flatMap((category) => category.items).find((item) => item.name === 'Masala Dosa');
    assert.ok(menuItem);
    const discountedOrder = async (clientMutationId, approvalPin) => fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...cashier.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, clientMutationId, type: 'Takeaway', items: [{ menuItemId: menuItem.id, quantity: 1 }], discountBps: 1100, approvalPin }),
    });
    const badPin = await discountedOrder(`bad-pin-${suffix}`, '0000');
    assert.equal(badPin.status, 403);
    assert.equal(await prisma.order.count({ where: { outletId: outlet.id, idempotencyKey: `bad-pin-${suffix}` } }), 0);
    const approvedOrderResponse = await discountedOrder(`approved-${suffix}`, '4826');
    const approvedOrder = await approvedOrderResponse.json();
    assert.equal(approvedOrderResponse.status, 201, JSON.stringify(approvedOrder));
    const approvalAudit = await prisma.auditLog.findFirst({ where: { outletId: outlet.id, entityId: approvedOrder.order.id, action: 'ORDER_DISCOUNT' } });
    assert.equal(approvalAudit?.userId, cashier.staff.id);
    assert.equal(approvalAudit?.approvalUserId, manager.staff.id);

    const waiterOrderResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...waiter.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, clientMutationId: `waiter-${suffix}`, type: 'Takeaway', items: [{ menuItemId: menuItem.id, quantity: 1 }] }),
    });
    const waiterOrder = await waiterOrderResponse.json();
    assert.equal(waiterOrderResponse.status, 201, JSON.stringify(waiterOrder));
    assert.equal('bill' in waiterOrder, false);
    assert.equal('totalPaise' in waiterOrder.order, false);
    assert.equal('unitPricePaise' in waiterOrder.order.items[0], false);
    const waiterOrders = await readJson(await fetch(`${api}/api/orders?outletId=${outlet.id}`, { headers: waiter.headers }));
    assert.equal(waiterOrders.status, 200);
    assert.ok(waiterOrders.body.some((order) => order.id === waiterOrder.order.id));
    assert.equal('totalPaise' in waiterOrders.body.find((order) => order.id === waiterOrder.order.id), false);
    const cashierOnlyPayment = await fetch(`${api}/api/orders/${waiterOrder.order.id}/payments`, {
      method: 'POST', headers: { ...waiter.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id }),
    });
    assert.equal(cashierOnlyPayment.status, 403);

    const updatedRoles = await fetch(`${api}/api/admin/staff?outletId=${outlet.id}`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, userId: waiter.staff.id, roleIds: [roleByName.get('WAITER').id, roleByName.get('CASHIER').id] }),
    });
    assert.equal(updatedRoles.status, 200, await updatedRoles.text());
    const newlyAllowedPayment = await fetch(`${api}/api/orders/${waiterOrder.order.id}/payments`, {
      method: 'POST', headers: { ...waiter.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, deviceId: `device-${suffix}`, clientMutationId: `payment-${suffix}`, amountPaise: 100, method: 'UPI' }),
    });
    assert.equal(newlyAllowedPayment.status, 201, await newlyAllowedPayment.text());
  } finally {
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
