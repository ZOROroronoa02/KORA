import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;

test('cloud POS flow: authenticated outlet menu, shift, idempotent order, KOT, guest and close', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const email = `pos-owner-${suffix}@example.test`;
    const password = 'KoraCloudFlow123!';
    const registrationResponse = await fetch(`${api}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantName: `Cloud Flow ${suffix}`, outletName: 'Test Outlet', name: 'POS Test Owner', email, password }),
    });
    const registration = await registrationResponse.json();
    assert.equal(registrationResponse.status, 201, JSON.stringify(registration));
    tenantId = registration.tenant.id;

    const loginResponse = await fetch(`${api}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantSlug: registration.tenant.slug, email, password }),
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200, JSON.stringify(login));
    assert.ok(login.accessToken);
    assert.match(loginResponse.headers.get('set-cookie') ?? '', /HttpOnly/);
    const headers = { authorization: `Bearer ${login.accessToken}` };

    const sessionResponse = await fetch(`${api}/api/auth/me`, { headers });
    const session = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);
    assert.equal(session.user.id, registration.user.id);
    assert.ok(session.outlets[0].permissions.includes('orders.create') === false, 'owner should not receive day-to-day order-taking access');
    assert.ok(session.outlets[0].permissions.includes('roles.manage'));
    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: registration.tenant.id, name: 'CASHIER' } } });
    await prisma.userOutletRole.create({ data: { userId: registration.user.id, outletId: registration.outlet.id, roleId: cashierRole.id } });

    const menuResponse = await fetch(`${api}/api/menu?outletId=${registration.outlet.id}`, { headers });
    const categories = await menuResponse.json();
    assert.equal(menuResponse.status, 200);
    assert.equal(categories.length, 5);
    const item = categories.flatMap((category) => category.items)[0];
    assert.ok(item?.id);
    const menuCreateResponse = await fetch(`${api}/api/menu`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, categoryId: categories[0].id, name: `Cloud special ${suffix}`, pricePaise: 7650 }),
    });
    const addedMenuItem = await menuCreateResponse.json();
    assert.equal(menuCreateResponse.status, 201, JSON.stringify(addedMenuItem));

    const tablesResponse = await fetch(`${api}/api/tables?outletId=${registration.outlet.id}`, { headers });
    const { tables } = await tablesResponse.json();
    assert.equal(tablesResponse.status, 200);
    assert.equal(tables.length, 10);
    const firstTable = tables.find((table) => !table.occupied);
    const secondTable = tables.find((table) => table.id !== firstTable.id && !table.occupied);
    assert.ok(firstTable && secondTable);

    const shiftOpenResponse = await fetch(`${api}/api/shifts`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, action: 'open', openingCashPaise: 500000 }),
    });
    assert.equal(shiftOpenResponse.status, 201, await shiftOpenResponse.text());

    const clientMutationId = `cloud-flow-${suffix}`;
    const orderPayload = {
      outletId: registration.outlet.id, clientMutationId, deviceId: `device-${suffix}`,
      type: 'Dine in', tableId: firstTable.id, items: [{ menuItemId: item.id, quantity: 2 }],
      paidPaise: 0, discountBps: 0,
    };
    const orderResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(orderPayload),
    });
    const created = await orderResponse.json();
    assert.equal(orderResponse.status, 201, JSON.stringify(created));
    assert.equal(created.order.items.length, 1);
    assert.equal(created.order.items[0].quantity, 2);
    assert.equal(created.kot.sequence, 1);
    assert.equal(created.bill.paymentStatus, 'PENDING');

    const replayResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(orderPayload),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, created.order.id);
    assert.equal(await prisma.order.count({ where: { tenantId } }), 1);

    const occupiedTables = await (await fetch(`${api}/api/tables?outletId=${registration.outlet.id}`, { headers })).json();
    assert.equal(occupiedTables.tables.find((table) => table.id === firstTable.id).occupied, true);

    const paymentPayload = { outletId: registration.outlet.id, deviceId: `device-${suffix}`, clientMutationId: `payment-${suffix}`, amountPaise: Math.floor(Number(created.bill.totalPaise) / 2), method: 'UPI' };
    const paymentResponse = await fetch(`${api}/api/orders/${created.order.id}/payments`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(paymentPayload),
    });
    const payment = await paymentResponse.json();
    assert.equal(paymentResponse.status, 201, JSON.stringify(payment));
    const paymentReplayResponse = await fetch(`${api}/api/orders/${created.order.id}/payments`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(paymentPayload),
    });
    const paymentReplay = await paymentReplayResponse.json();
    assert.equal(paymentReplayResponse.status, 200, JSON.stringify(paymentReplay));
    assert.equal(paymentReplay.replayed, true);
    assert.equal(await prisma.payment.count({ where: { billId: created.bill.id } }), 1);
    assert.equal((await prisma.bill.findUniqueOrThrow({ where: { id: created.bill.id } })).paymentStatus, 'PARTIAL');

    const orderListResponse = await fetch(`${api}/api/orders?outletId=${registration.outlet.id}`, { headers });
    const orderList = await orderListResponse.json();
    assert.equal(orderListResponse.status, 200);
    assert.equal(orderList[0].id, created.order.id);
    assert.equal(orderList[0].table.label, firstTable.label);

    const readyResponse = await fetch(`${api}/api/orders/${created.order.id}`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, action: 'kot-ready' }),
    });
    const ready = await readyResponse.json();
    assert.equal(readyResponse.status, 200, JSON.stringify(ready));
    assert.equal(ready.order.status, 'READY');
    const servedResponse = await fetch(`${api}/api/orders/${created.order.id}`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, action: 'kot-served' }),
    });
    const served = await servedResponse.json();
    assert.equal(servedResponse.status, 200, JSON.stringify(served));
    assert.equal(served.order.status, 'SERVED');

    const transferResponse = await fetch(`${api}/api/orders/${created.order.id}`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, action: 'transfer-table', tableId: secondTable.id }),
    });
    const transferred = await transferResponse.json();
    assert.equal(transferResponse.status, 200, JSON.stringify(transferred));
    assert.equal(transferred.order.tableId, secondTable.id);
    const tablesAfterTransfer = await (await fetch(`${api}/api/tables?outletId=${registration.outlet.id}`, { headers })).json();
    assert.equal(tablesAfterTransfer.tables.find((table) => table.id === firstTable.id).occupied, false);
    assert.equal(tablesAfterTransfer.tables.find((table) => table.id === secondTable.id).occupied, true);

    const unavailableResponse = await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: item.id, available: false }),
    });
    assert.equal(unavailableResponse.status, 200);
    const rejectedOrder = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...orderPayload, clientMutationId: `${clientMutationId}-unavailable`, tableId: tables[2].id }),
    });
    assert.equal(rejectedOrder.status, 409);
    await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: item.id, available: true }),
    });

    const phone = `+919${[...suffix].map((digit) => String(Number.parseInt(digit, 16) % 10)).join('')}`;
    const guestResponse = await fetch(`${api}/api/customers`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, name: 'Test Guest', phone }),
    });
    const guest = await guestResponse.json();
    assert.equal(guestResponse.status, 201, JSON.stringify(guest));
    assert.match(guest.phone, /\d{4}$/);
    await fetch(`${api}/api/customers`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, name: 'Test Guest', phone }),
    });
    const guestLink = await prisma.customerOutlet.findUnique({ where: { customerId_outletId: { customerId: guest.id, outletId: registration.outlet.id } } });
    assert.equal(guestLink.visits, 0, 'profile creation must not count as a visit');

    const guestOrderPayload = { outletId: registration.outlet.id, clientMutationId: `guest-order-${suffix}`, deviceId: `device-${suffix}`, type: 'Takeaway', customerId: guest.id, items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 500, paymentMethod: 'Cash' };
    const guestOrderResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(guestOrderPayload),
    });
    const guestOrder = await guestOrderResponse.json();
    assert.equal(guestOrderResponse.status, 201, JSON.stringify(guestOrder));
    assert.equal(guestOrder.bill.paymentStatus, 'PARTIAL');
    const guestLinkAfterSale = await prisma.customerOutlet.findUnique({ where: { customerId_outletId: { customerId: guest.id, outletId: registration.outlet.id } } });
    assert.equal(guestLinkAfterSale.visits, 1, 'a new idempotent sale records exactly one guest visit');
    assert.equal(guestLinkAfterSale.spendPaise.toString(), guestOrder.order.totalPaise);
    await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(guestOrderPayload),
    });
    const guestLinkAfterReplay = await prisma.customerOutlet.findUnique({ where: { customerId_outletId: { customerId: guest.id, outletId: registration.outlet.id } } });
    assert.equal(guestLinkAfterReplay.visits, 1, 'replaying a sale must not duplicate customer metrics');

    const shiftCloseResponse = await fetch(`${api}/api/shifts`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, action: 'close', countedCashPaise: 500500 }),
    });
    const shiftClose = await shiftCloseResponse.json();
    assert.equal(shiftCloseResponse.status, 200, JSON.stringify(shiftClose));
    assert.equal(shiftClose.reconciliation.variancePaise, 0);
  } finally {
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }
});
