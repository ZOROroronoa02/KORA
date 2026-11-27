import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import { accessTokenSigningKey } from '../src/lib/jwt-secret.ts';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL && process.env.JWT_ACCESS_SECRET);

function todayIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

test('shift reports isolate outlets, enforce both report permissions, paginate, reconcile ledgers, and neutralize CSV formulas', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  const tenantIds = [];
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenant = await prisma.tenant.create({ data: { name: `Shift Reports ${suffix}`, slug: `shift-reports-${suffix}` } });
    tenantIds.push(tenant.id);
    const outlet = await prisma.outlet.create({ data: { tenantId: tenant.id, name: 'Shift report outlet', code: `SR-${suffix}` } });
    const otherOutlet = await prisma.outlet.create({ data: { tenantId: tenant.id, name: 'Unassigned outlet', code: `SRO-${suffix}` } });
    const outsiderTenant = await prisma.tenant.create({ data: { name: `Other tenant ${suffix}`, slug: `other-shifts-${suffix}` } });
    tenantIds.push(outsiderTenant.id);
    const outsiderOutlet = await prisma.outlet.create({ data: { tenantId: outsiderTenant.id, name: 'Other tenant outlet', code: `SRT-${suffix}` } });
    const outsiderUser = await prisma.user.create({ data: {
      tenantId: outsiderTenant.id, name: 'Other tenant cashier', email: `other-tenant-${suffix}@example.test`, passwordHash: 'unused-test-password-hash',
    } });
    const users = {};
    const addUser = async (label, keys) => {
      const user = await prisma.user.create({ data: {
        tenantId: tenant.id,
        name: label,
        email: `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${suffix}@example.test`,
        passwordHash: 'unused-test-password-hash',
      } });
      const permissions = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
      assert.equal(permissions.length, keys.length, 'shift report permission keys must be seeded');
      const role = await prisma.role.create({ data: {
        tenantId: tenant.id,
        name: `${label.replaceAll(/[^a-zA-Z0-9]+/g, '_')}_${suffix}`,
        description: 'Shift report API integration test',
        permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) },
      } });
      await prisma.userOutletRole.create({ data: { userId: user.id, outletId: outlet.id, roleId: role.id } });
      const token = await new SignJWT({ tenantId: tenant.id })
        .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('5m')
        .sign(accessTokenSigningKey(process.env.JWT_ACCESS_SECRET));
      users[label] = { user, headers: { authorization: `Bearer ${token}` } };
      return user;
    };
    const fullAccess = await addUser('=Shift Formula', ['reports.view.financial', 'reports.view.staff_performance']);
    await addUser('Finance only', ['reports.view.financial']);
    await addUser('Staff only', ['reports.view.staff_performance']);
    await addUser('No report access', ['orders.read']);

    const closedOpenedAt = new Date(Date.now() - 120_000);
    const closedAt = new Date(Date.now() - 30_000);
    const closedShift = await prisma.shift.create({ data: {
      tenantId: tenant.id, outletId: outlet.id, userId: fullAccess.id, status: 'CLOSED', openingCashPaise: 1000n,
      expectedCashPaise: 2300n, countedCashPaise: 2250n, variancePaise: -50n, openedAt: closedOpenedAt, closedAt,
    } });
    const openShift = await prisma.shift.create({ data: {
      tenantId: tenant.id, outletId: outlet.id, userId: fullAccess.id, activeKey: `active-${suffix}`, status: 'OPEN', openingCashPaise: 1000n,
      openedAt: new Date(Date.now() - 10_000),
    } });
    await prisma.shift.create({ data: {
      tenantId: tenant.id, outletId: otherOutlet.id, userId: fullAccess.id, status: 'CLOSED', openingCashPaise: 99000n,
      expectedCashPaise: 99000n, countedCashPaise: 99000n, variancePaise: 0n, openedAt: closedOpenedAt, closedAt,
    } });
    await prisma.shift.create({ data: {
      tenantId: outsiderTenant.id, outletId: outsiderOutlet.id, userId: outsiderUser.id, status: 'CLOSED', openingCashPaise: 88000n,
      expectedCashPaise: 88000n, countedCashPaise: 88000n, variancePaise: 0n, openedAt: closedOpenedAt, closedAt,
    } });

    const createBill = async (orderNumber, selectedOutletId) => {
      const order = await prisma.order.create({ data: {
        tenantId: tenant.id, outletId: selectedOutletId, orderNumber, type: 'TAKEAWAY', status: 'COMPLETED',
        idempotencyKey: `shift-report-${suffix}-${orderNumber}`, subtotalPaise: 2000n, totalPaise: 2000n,
      } });
      return prisma.bill.create({ data: {
        tenantId: tenant.id, outletId: selectedOutletId, orderId: order.id, invoiceNumber: `SR-${suffix}-${orderNumber}`,
        supplierNameSnapshot: 'Shift Report Restaurant', subtotalPaise: 2000n, taxablePaise: 2000n, totalPaise: 2000n,
      } });
    };
    const closedBill = await createBill(1, outlet.id);
    const openBill = await createBill(2, outlet.id);
    const cashPayment = await prisma.payment.create({ data: { billId: closedBill.id, shiftId: closedShift.id, method: 'CASH', amountPaise: 1500n } });
    const upiPayment = await prisma.payment.create({ data: { billId: closedBill.id, shiftId: closedShift.id, method: 'UPI', amountPaise: 500n } });
    await prisma.paymentReversal.create({ data: {
      tenantId: tenant.id, outletId: outlet.id, paymentId: cashPayment.id, shiftId: closedShift.id, createdById: fullAccess.id,
      method: 'CASH', amountPaise: 200n, reason: 'Shift report test refund',
    } });
    await prisma.paymentReversal.create({ data: {
      tenantId: tenant.id, outletId: outlet.id, paymentId: upiPayment.id, createdById: fullAccess.id,
      method: 'UPI', amountPaise: 50n, reason: 'Shift report non-cash refund attribution',
    } });
    await prisma.payment.create({ data: { billId: openBill.id, shiftId: openShift.id, method: 'CASH', amountPaise: 500n } });

    const day = todayIndia();
    const query = new URLSearchParams({ outletId: outlet.id, from: day, to: day, limit: '1' });
    const firstResponse = await fetch(`${api}/api/reports/shifts?${query}`, { headers: users['=Shift Formula'].headers });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(first));
    assert.equal(first.rows.length, 1);
    assert.ok(first.nextCursor);
    assert.equal(first.rows[0].id, openShift.id, 'newest shift is returned first');
    assert.equal(first.rows[0].expectedCashPaise, '1500', 'open expected cash is derived from its shift-specific ledger');
    assert.deepEqual(first.rows[0].payments, [{ method: 'CASH', amountPaise: '500' }]);

    const nextQuery = new URLSearchParams(query);
    nextQuery.set('cursor', first.nextCursor);
    const secondResponse = await fetch(`${api}/api/reports/shifts?${nextQuery}`, { headers: users['=Shift Formula'].headers });
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200, JSON.stringify(second));
    assert.equal(second.rows.length, 1);
    assert.equal(second.rows[0].id, closedShift.id);
    assert.equal(second.rows[0].cashCapturedPaise, '1500');
    assert.equal(second.rows[0].cashRefundedPaise, '200');
    assert.equal(second.rows[0].expectedCashPaise, '2300');
    assert.equal(second.rows[0].countedCashPaise, '2250');
    assert.equal(second.rows[0].variancePaise, '-50');
    assert.equal(second.rows[0].ledgerMatchesClose, true);
    assert.deepEqual(second.rows[0].payments, [{ method: 'CASH', amountPaise: '1500' }, { method: 'UPI', amountPaise: '500' }]);
    assert.deepEqual(second.rows[0].refunds, [{ method: 'CASH', amountPaise: '200' }], 'refund activity is attributed only to an explicitly recorded shift; non-cash refunds without a shift stay in outlet-level reporting');
    assert.equal(second.nextCursor, null);

    const csvQuery = new URLSearchParams(query);
    csvQuery.set('limit', '50');
    csvQuery.set('format', 'csv');
    const csvResponse = await fetch(`${api}/api/reports/shifts?${csvQuery}`, { headers: users['=Shift Formula'].headers });
    const csv = await csvResponse.text();
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
    assert.match(csv, /'=Shift Formula/, 'spreadsheet formula-like cashier names are neutralized');
    assert.doesNotMatch(csv, /Other tenant|Unassigned outlet/);

    for (const label of ['Finance only', 'Staff only', 'No report access']) {
      const denied = await fetch(`${api}/api/reports/shifts?${query}`, { headers: users[label].headers });
      assert.equal(denied.status, 403, `${label} must not see shift reports`);
    }
    const wrongOutlet = await fetch(`${api}/api/reports/shifts?outletId=${otherOutlet.id}&from=${day}&to=${day}`, { headers: users['=Shift Formula'].headers });
    assert.equal(wrongOutlet.status, 403, 'same-tenant outlet must be independently authorized');
    const wrongTenant = await fetch(`${api}/api/reports/shifts?outletId=${outsiderOutlet.id}&from=${day}&to=${day}`, { headers: users['=Shift Formula'].headers });
    assert.equal(wrongTenant.status, 403, 'cross-tenant outlet must be denied');
    const foreignCursor = await fetch(`${api}/api/reports/shifts?outletId=${outlet.id}&from=${day}&to=${day}&cursor=${encodeURIComponent('not-a-local-cursor')}`, { headers: users['=Shift Formula'].headers });
    assert.equal(foreignCursor.status, 400);
    const invalidRange = await fetch(`${api}/api/reports/shifts?outletId=${outlet.id}&from=2026-02-30&to=2026-02-30`, { headers: users['=Shift Formula'].headers });
    assert.equal(invalidRange.status, 400);
  } finally {
    for (const tenantId of tenantIds) await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }
});
