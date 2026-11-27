import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { indianFinancialYear } from '../src/lib/billing.ts';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;

test('API security integration: tenant isolation, concurrent billing, and payment reversals', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  let foreignTenantId;
  const readJson = async (response) => {
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('Non-JSON HTTP ' + response.status + ': ' + text.slice(0, 300)); }
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + JSON.stringify(body));
    return body;
  };
  try {
    const activeOwnershipGuards = await prisma.$queryRaw`
      SELECT c.relname AS table_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND t.tgname LIKE 'kora_tenant_guard_%' AND NOT t.tgisinternal
    `;
    const guardedTables = new Set(activeOwnershipGuards.map((trigger) => trigger.table_name));
    for (const tableName of ['customer_outlets', 'orders', 'order_items', 'kots', 'bills', 'payments', 'shifts', 'raw_materials', 'purchases', 'audit_logs']) {
      assert.ok(guardedTables.has(tableName), `database ownership trigger missing for ${tableName}`);
    }
    const ledgerTriggers = await prisma.$queryRaw`SELECT tgname FROM pg_trigger WHERE tgname IN ('kora_payment_reversals_ownership', 'kora_payment_reversals_append_only', 'kora_payments_append_only') AND NOT tgisinternal`;
    assert.equal(ledgerTriggers.length, 3, 'captured payments and refunds need database ownership/append-only triggers');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const registerResponse = await fetch(api + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantName: 'Security Test ' + suffix, outletName: 'Outlet A', name: 'Test Owner', email: 'owner-' + suffix + '@example.test', password: 'LongEnoughPass123!' }),
    });
    const registered = await readJson(registerResponse);
    assert.equal(registerResponse.status, 201);
    tenantId = registered.tenant.id;
    const ownerHeaders = { authorization: 'Bearer ' + registered.accessToken };
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'OWNER' } } });
    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'CASHIER' } } });
    await prisma.userOutletRole.create({ data: { userId: registered.user.id, outletId: registered.outlet.id, roleId: cashierRole.id } });
    const outletB = await prisma.outlet.create({ data: { tenantId, name: 'Outlet B', code: 'T-' + suffix } });
    await prisma.userOutletRole.create({ data: { userId: registered.user.id, outletId: outletB.id, roleId: ownerRole.id } });

    const foreignTenant = await prisma.tenant.create({ data: { name: 'Foreign Tenant ' + suffix, slug: 'foreign-' + suffix } });
    foreignTenantId = foreignTenant.id;
    const foreignOutlet = await prisma.outlet.create({ data: { tenantId: foreignTenant.id, name: 'Foreign Outlet', code: 'F-' + suffix } });
    const crossTenantRead = await fetch(api + '/api/customers?outletId=' + foreignOutlet.id, { headers: ownerHeaders });
    assert.equal(crossTenantRead.status, 403, 'a valid user from another tenant cannot read a foreign outlet');
    const crossTenantWrite = await fetch(api + '/api/customers', {
      method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: foreignOutlet.id, phone: '+919' + suffix.padEnd(9, '0'), name: 'Cross-Tenant Attempt' }),
    });
    assert.equal(crossTenantWrite.status, 403, 'a valid user from another tenant cannot write to a foreign outlet');

    const foreignCustomer = await prisma.customer.create({
      data: { tenantId: foreignTenantId, phone: '+918' + suffix.padEnd(9, '0'), name: 'Foreign Customer' },
    });
    const foreignCategory = await prisma.menuCategory.create({
      data: { tenantId: foreignTenantId, outletId: foreignOutlet.id, name: 'Foreign Category' },
    });
    const foreignMenuItem = await prisma.menuItem.create({
      data: { tenantId: foreignTenantId, categoryId: foreignCategory.id, name: 'Foreign Item', basePricePaise: 500n },
    });
    const assertDatabaseOwnershipRejection = (error) => {
      const details = JSON.stringify({ code: error.code, meta: error.meta, message: error.message });
      assert.match(details, /kora_tenant_ownership_guard|KORA ownership (violation|fields are immutable)/i);
      return true;
    };
    await assert.rejects(
      prisma.customerOutlet.create({ data: { customerId: foreignCustomer.id, outletId: registered.outlet.id } }),
      assertDatabaseOwnershipRejection,
      'direct Prisma writes cannot link a customer to an outlet in another tenant',
    );
    await assert.rejects(
      prisma.customer.update({ where: { id: foreignCustomer.id }, data: { tenantId } }),
      assertDatabaseOwnershipRejection,
      'direct Prisma updates cannot move an existing customer between tenants',
    );
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: foreignCustomer.id } })).tenantId, foreignTenantId);
    const crossTenantNestedOrderKey = 'cross-tenant-nested-' + suffix;
    await assert.rejects(
      prisma.order.create({
        data: {
          tenantId,
          outletId: registered.outlet.id,
          orderNumber: 900000 + Number.parseInt(suffix.slice(0, 4), 16),
          idempotencyKey: crossTenantNestedOrderKey,
          type: 'TAKEAWAY',
          items: { create: [{ menuItemId: foreignMenuItem.id, nameSnapshot: foreignMenuItem.name, quantity: 1, unitPricePaise: 500n, gstBps: 500, totalPaise: 500n }] },
        },
      }),
      assertDatabaseOwnershipRejection,
      'nested order-item writes cannot reference another tenant menu item',
    );
    assert.equal(await prisma.order.count({ where: { tenantId, outletId: registered.outlet.id, idempotencyKey: crossTenantNestedOrderKey } }), 0,
      'a rejected nested write must roll back its parent order');

    const phone = '+91' + randomUUID().replace(/\D/g, '').slice(0, 10);
    const customer = await prisma.customer.create({ data: { tenantId, phone, name: 'Private Outlet B Guest', email: 'private-' + suffix + '@example.test', birthday: new Date('1990-01-01'), consentAt: new Date() } });
    await prisma.customerOutlet.create({ data: { customerId: customer.id, outletId: outletB.id } });
    const customersA = await readJson(await fetch(api + '/api/customers?outletId=' + registered.outlet.id, { headers: ownerHeaders }));
    const customersB = await readJson(await fetch(api + '/api/customers?outletId=' + outletB.id, { headers: ownerHeaders }));
    assert.equal(customersA.some((entry) => entry.id === customer.id), false);
    const customerB = customersB.find((entry) => entry.id === customer.id);
    assert.ok(customerB);
    assert.equal(typeof customerB.outlet.spendPaise, 'string');

    const waiterRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'WAITER' } } });
    const waiterEmail = 'waiter-' + suffix + '@example.test';
    const waiter = await prisma.user.create({ data: { tenantId, name: 'Test Waiter', email: waiterEmail, passwordHash: await hash('WaiterPass123!', 4) } });
    await prisma.userOutletRole.create({ data: { userId: waiter.id, outletId: registered.outlet.id, roleId: waiterRole.id } });
    const waiterLogin = await readJson(await fetch(api + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantSlug: registered.tenant.slug, email: waiterEmail, password: 'WaiterPass123!' }),
    }));
    const forbidden = await fetch(api + '/api/customers', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + waiterLogin.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, phone, name: 'Unauthorized Profile Rewrite' }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).name, 'Private Outlet B Guest');
    assert.equal(await prisma.customerOutlet.count({ where: { customerId: customer.id, outletId: registered.outlet.id } }), 0);

    const categories = await readJson(await fetch(api + '/api/menu?outletId=' + registered.outlet.id, { headers: ownerHeaders }));
    const item = categories.flatMap((category) => category.items).find((entry) => entry.name === 'Masala Dosa');
    assert.ok(item);
    const order = await readJson(await fetch(api + '/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, clientMutationId: 'security-split-' + suffix, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    }));
    const fiscalYear = indianFinancialYear(new Date());
    assert.ok(order.bill.invoiceNumber.includes(`-FY${fiscalYear.label.slice(2, 4)}${fiscalYear.label.slice(5, 7)}-`), 'invoice number must use the current India financial year');
    assert.ok(order.bill.invoiceNumber.length <= 16, 'GST invoice serial must be no longer than 16 characters');
    const wrongOutletInvoice = await fetch(api + '/api/bills/' + order.bill.id + '/invoice?outletId=' + outletB.id, { headers: ownerHeaders });
    assert.equal(wrongOutletInvoice.status, 404, 'invoice details must be scoped to the selected outlet even for an owner on both outlets');
    const concurrentOrders = await Promise.all([1, 2].map(async (index) => readJson(await fetch(api + '/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, clientMutationId: `security-invoice-${suffix}-${index}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    }))));
    const invoiceSequences = [order.bill, ...concurrentOrders.map((entry) => entry.bill)].map((bill) => Number(bill.invoiceNumber.match(/-(\d{6})$/)?.[1]));
    assert.deepEqual(invoiceSequences.sort((a, b) => a - b), [1, 2, 3], 'concurrent orders must each receive the next unique invoice sequence');
    const total = BigInt(order.bill.totalPaise);
    const half = Number(total / 2n);
    const splitBody = JSON.stringify({ outletId: registered.outlet.id, mode: 'amount', amounts: [half, Number(total) - half] });
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(api + '/api/bills/' + order.bill.id + '/split', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken }, body: splitBody,
    })));
    const statuses = responses.map((response) => response.status);
    const splits = await prisma.billSplit.findMany({ where: { billId: order.bill.id } });
    assert.equal(statuses.filter((status) => status === 201).length, 1);
    assert.equal(statuses.filter((status) => status === 409).length, 7);
    assert.equal(splits.length, 2);
    assert.equal(splits.reduce((sum, split) => sum + split.totalPaise, 0n), total);

    const refundOrder = await readJson(await fetch(api + '/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, clientMutationId: `security-refund-order-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    }));
    const refundTotal = Number(refundOrder.bill.totalPaise);
    const sourcePayment = await readJson(await fetch(api + `/api/orders/${refundOrder.order.id}/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, deviceId: `security-device-${suffix}`, clientMutationId: `security-refund-pay-${suffix}`, amountPaise: refundTotal, method: 'UPI' }),
    }));
    await assert.rejects(
      prisma.payment.update({ where: { id: sourcePayment.payment.id }, data: { amountPaise: 1n } }),
      (error) => /payments_append_only|append-only/i.test(JSON.stringify({ code: error.code, meta: error.meta, message: error.message })),
      'captured payments cannot be edited to evade the refund ledger',
    );
    const refundUrl = api + `/api/orders/${refundOrder.order.id}/payments/${sourcePayment.payment.id}/refunds`;
    const firstRefundBody = { outletId: registered.outlet.id, deviceId: `security-device-${suffix}`, clientMutationId: `security-refund-${suffix}-001`, amountPaise: Math.floor(refundTotal / 2), reason: 'Guest requested refund' };
    const firstRefundResponse = await fetch(refundUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken }, body: JSON.stringify(firstRefundBody) });
    assert.equal(firstRefundResponse.status, 201);
    const firstRefund = await firstRefundResponse.json();
    assert.equal((await prisma.bill.findUniqueOrThrow({ where: { id: refundOrder.bill.id } })).paymentStatus, 'PARTIAL');
    const deniedRefund = await fetch(refundUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + waiterLogin.accessToken }, body: JSON.stringify({ ...firstRefundBody, clientMutationId: `security-refund-denied-${suffix}-1` }) });
    assert.equal(deniedRefund.status, 403, 'waiters must not record refunds');
    const crossTenantRefund = await fetch(refundUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken }, body: JSON.stringify({ ...firstRefundBody, outletId: foreignOutlet.id, clientMutationId: `security-refund-cross-${suffix}-1` }) });
    assert.equal(crossTenantRefund.status, 403, 'a refund cannot be routed through another tenant outlet');
    const replayResponse = await fetch(refundUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken }, body: JSON.stringify(firstRefundBody) });
    assert.equal(replayResponse.status, 200, 'retrying the same mutation must replay the original refund');
    assert.equal((await replayResponse.json()).reversal.id, firstRefund.reversal.id);
    assert.equal(await prisma.paymentReversal.count({ where: { paymentId: sourcePayment.payment.id } }), 1);
    const refusedVoid = await fetch(api + `/api/orders/${refundOrder.order.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, action: 'void', reason: 'Refund incomplete' }),
    });
    assert.equal(refusedVoid.status, 409, 'an order with remaining captured funds must not be voided');
    const overRefund = await fetch(refundUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken }, body: JSON.stringify({ ...firstRefundBody, clientMutationId: `security-refund-over-${suffix}-1`, amountPaise: refundTotal }) });
    assert.equal(overRefund.status, 409, 'refunds above the source payment balance must fail');
    const remainingRefundPaise = refundTotal - firstRefundBody.amountPaise;
    const competingRefunds = await Promise.all([2, 3].map((index) => fetch(refundUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ ...firstRefundBody, clientMutationId: `security-refund-${suffix}-00${index}`, amountPaise: remainingRefundPaise }),
    })));
    const competingStatuses = competingRefunds.map((response) => response.status).sort((a, b) => a - b);
    assert.deepEqual(competingStatuses, [201, 409], 'only one concurrent refund may consume the remaining captured balance');
    assert.equal((await prisma.bill.findUniqueOrThrow({ where: { id: refundOrder.bill.id } })).paymentStatus, 'REFUNDED');
    const reversedTotal = await prisma.paymentReversal.aggregate({ where: { paymentId: sourcePayment.payment.id }, _sum: { amountPaise: true } });
    assert.equal(reversedTotal._sum.amountPaise, BigInt(refundTotal), 'concurrent retries must never reverse more than the captured payment');
    const voidAfterRefund = await fetch(api + `/api/orders/${refundOrder.order.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, action: 'void', reason: 'Fully refunded order' }),
    });
    assert.equal(voidAfterRefund.status, 200, 'fully refunded orders can be voided with an audit trail');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: refundOrder.order.id } })).status, 'CANCELLED');
    await assert.rejects(
      prisma.paymentReversal.update({ where: { id: firstRefund.reversal.id }, data: { amountPaise: 1n } }),
      (error) => /payment_reversals_append_only|append-only/i.test(JSON.stringify({ code: error.code, meta: error.meta, message: error.message })),
      'refund ledger entries must not be editable through direct database access',
    );

    const openedShift = await readJson(await fetch(api + '/api/shifts', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, action: 'open', openingCashPaise: 100000 }),
    }));
    const cashOrder = await readJson(await fetch(api + '/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, clientMutationId: `security-cash-order-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    }));
    const cashAmount = Number(cashOrder.bill.totalPaise);
    const cashPayment = await readJson(await fetch(api + `/api/orders/${cashOrder.order.id}/payments`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, deviceId: `security-device-${suffix}`, clientMutationId: `security-cash-pay-${suffix}`, amountPaise: cashAmount, method: 'Cash' }),
    }));
    const cashRefund = await fetch(api + `/api/orders/${cashOrder.order.id}/payments/${cashPayment.payment.id}/refunds`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, deviceId: `security-device-${suffix}`, clientMutationId: `security-cash-refund-${suffix}-1`, amountPaise: cashAmount, reason: 'Cash order reversal' }),
    });
    assert.equal(cashRefund.status, 201, 'cash reversal should be recorded against an open shift');
    const cashRefundBody = await cashRefund.json();
    assert.equal(cashRefundBody.reversal.shiftId, openedShift.shift.id);
    const closedShift = await readJson(await fetch(api + '/api/shifts', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + registered.accessToken },
      body: JSON.stringify({ outletId: registered.outlet.id, action: 'close', countedCashPaise: 100000 }),
    }));
    assert.equal(closedShift.reconciliation.expectedCashPaise, 100000, 'cash refund must reduce expected shift cash');
    assert.equal(closedShift.reconciliation.variancePaise, 0);
  } finally {
    if (foreignTenantId) await prisma.tenant.deleteMany({ where: { id: foreignTenantId } }).catch(() => undefined);
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
