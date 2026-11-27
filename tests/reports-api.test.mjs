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

test('sales reports enforce outlet permissions, aggregate persisted ledgers, redact fields, and export safe CSV', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenant = await prisma.tenant.create({ data: { name: `Reports ${suffix}`, slug: `reports-${suffix}` } });
    tenantId = tenant.id;
    const outlet = await prisma.outlet.create({ data: { tenantId, name: 'Report outlet', code: `R-${suffix}` } });
    const otherOutlet = await prisma.outlet.create({ data: { tenantId, name: 'Other outlet', code: `RO-${suffix}` } });
    const users = {};
    const addUser = async (label, keys) => {
      const user = await prisma.user.create({ data: { tenantId, name: label, email: `${label.toLowerCase().replaceAll(' ', '-')}-${suffix}@example.test`, passwordHash: 'unused-test-password-hash' } });
      const permissions = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
      assert.equal(permissions.length, keys.length, 'report permission keys must be seeded');
      const role = await prisma.role.create({ data: { tenantId, name: `${label.replaceAll(' ', '_')}_${suffix}`, description: 'Report API integration test', permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) } } });
      await prisma.userOutletRole.create({ data: { userId: user.id, outletId: outlet.id, roleId: role.id } });
      const token = await new SignJWT({ tenantId })
        .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('5m')
        .sign(accessTokenSigningKey(process.env.JWT_ACCESS_SECRET));
      users[label] = { user, headers: { authorization: `Bearer ${token}` } };
    };
    await addUser('Finance reader', ['reports.view.sales', 'reports.view.financial', 'reports.view.gst']);
    await addUser('Sales reader', ['reports.view.sales']);
    await addUser('No report access', ['orders.read']);

    const createBill = async ({ outletId, index, status, name, quantity, totalPaise }) => {
      const order = await prisma.order.create({ data: {
        tenantId, outletId, orderNumber: index, type: 'TAKEAWAY', status, idempotencyKey: `report-order-${suffix}-${index}`,
        subtotalPaise: 10000n, discountPaise: 500n, taxPaise: 950n, serviceChargePaise: 0n, totalPaise,
      } });
      await prisma.orderItem.create({ data: { orderId: order.id, nameSnapshot: name, quantity, unitPricePaise: 5000n, gstBps: 500, discountPaise: 500n, totalPaise: 9500n } });
      return prisma.bill.create({ data: {
        tenantId, outletId, orderId: order.id, invoiceNumber: `R-${suffix}-${index}`, supplierNameSnapshot: 'Reports Test Restaurant',
        subtotalPaise: 10000n, discountPaise: 500n, taxablePaise: 9500n, cgstPaise: 237n, sgstPaise: 238n, totalPaise,
        issuedAt: new Date(),
      } });
    };
    const activeBill = await createBill({ outletId: outlet.id, index: 1, status: 'PREPARING', name: '=2+2', quantity: 2, totalPaise: 9975n });
    const cancelledBill = await createBill({ outletId: outlet.id, index: 2, status: 'CANCELLED', name: 'Voided item', quantity: 99, totalPaise: 99000n });
    await createBill({ outletId: otherOutlet.id, index: 1, status: 'PREPARING', name: 'Other outlet item', quantity: 50, totalPaise: 88000n });
    const payment = await prisma.payment.create({ data: { billId: activeBill.id, method: 'UPI', amountPaise: 9975n, recordedAt: new Date() } });
    await prisma.paymentReversal.create({ data: {
      tenantId, outletId: outlet.id, paymentId: payment.id, createdById: users['Finance reader'].user.id,
      method: 'UPI', amountPaise: 2000n, reason: 'Report test refund', recordedAt: new Date(),
    } });
    const voidedOrderPayment = await prisma.payment.create({ data: { billId: cancelledBill.id, method: 'CASH', amountPaise: 99000n, recordedAt: new Date() } });
    await prisma.paymentReversal.create({ data: {
      tenantId, outletId: outlet.id, paymentId: voidedOrderPayment.id, createdById: users['Finance reader'].user.id,
      method: 'CASH', amountPaise: 99000n, reason: 'Voided order refund', recordedAt: new Date(),
    } });

    const day = todayIndia();
    const query = `outletId=${outlet.id}&from=${day}&to=${day}`;
    const response = await fetch(`${api}/api/reports/sales?${query}`, { headers: users['Finance reader'].headers });
    const report = await response.json();
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.deepEqual(report.range, { from: day, to: day, timeZone: 'Asia/Kolkata', maxDays: 93 });
    assert.equal(report.summary.billCount, 1, 'voided bills and other outlets must be excluded');
    assert.equal(report.financials.billedTotalPaise, '9975');
    assert.equal(report.financials.discountPaise, '500');
    assert.deepEqual(report.paymentActivity, [{ method: 'CASH', amountPaise: '99000' }, { method: 'UPI', amountPaise: '9975' }], 'payment activity follows payment timestamps even when a bill was later voided');
    assert.deepEqual(report.refundActivity, [{ method: 'CASH', amountPaise: '99000' }, { method: 'UPI', amountPaise: '2000' }]);
    assert.equal(report.topItems[0].quantity, '2');
    assert.equal(report.gstSummary[0].cgstPaise, '237');

    const csvResponse = await fetch(`${api}/api/reports/sales?${query}&format=csv`, { headers: users['Finance reader'].headers });
    const csv = await csvResponse.text();
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
    assert.match(csv, /'=2\+2/, 'spreadsheet formula-like item names are neutralized');

    const salesOnlyResponse = await fetch(`${api}/api/reports/sales?${query}`, { headers: users['Sales reader'].headers });
    const salesOnly = await salesOnlyResponse.json();
    assert.equal(salesOnlyResponse.status, 200);
    assert.equal(salesOnly.summary.billCount, 1);
    assert.equal('financials' in salesOnly, false);
    assert.equal('paymentActivity' in salesOnly, false);
    assert.equal('salesPaise' in salesOnly.topItems[0], false);

    const denied = await fetch(`${api}/api/reports/sales?${query}`, { headers: users['No report access'].headers });
    assert.equal(denied.status, 403);
    const wrongOutlet = await fetch(`${api}/api/reports/sales?outletId=${otherOutlet.id}&from=${day}&to=${day}`, { headers: users['Finance reader'].headers });
    assert.equal(wrongOutlet.status, 403);
    const invalidDay = await fetch(`${api}/api/reports/sales?outletId=${outlet.id}&from=2026-02-30&to=2026-02-30`, { headers: users['Finance reader'].headers });
    assert.equal(invalidDay.status, 400);
    const invalidEndDay = await fetch(`${api}/api/reports/sales?outletId=${outlet.id}&from=2026-02-28&to=2026-02-30`, { headers: users['Finance reader'].headers });
    assert.equal(invalidEndDay.status, 400);
    const tooLong = await fetch(`${api}/api/reports/sales?outletId=${outlet.id}&from=2026-01-01&to=2026-04-10`, { headers: users['Finance reader'].headers });
    assert.equal(tooLong.status, 400);
  } finally {
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }
});
