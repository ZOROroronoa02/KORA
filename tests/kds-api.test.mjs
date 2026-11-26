import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL);
const headersFor = (token) => ({ authorization: `Bearer ${token}` });
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;
const jsonResponse = async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) });

test('KDS API enforces outlet permissions, idempotent transitions, routing, metrics, and reprint audit', { skip: !enabled, timeout: 90000 }, async () => {
  const prisma = new PrismaClient();
  const tenants = [];
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const registration = await jsonResponse(await fetch(`${api}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantName: `KDS Test ${suffix}`, outletName: 'Kitchen outlet', name: 'KDS Owner', email: `kds-owner-${suffix}@example.test`, password: 'KoraKdsPass123!' }),
    }));
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    const { tenant, outlet } = registration.body;
    const ownerHeaders = headersFor(registration.body.accessToken);
    tenants.push(tenant.id);
    const makeStaff = async (roleName, label) => {
      const email = `kds-${label.toLowerCase()}-${suffix}@example.test`;
      const password = `Kds${label}Pass123!`;
      const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: tenant.id, name: roleName } } });
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: label, email, passwordHash: await hash(password, 4) } });
      await prisma.userOutletRole.create({ data: { userId: user.id, outletId: outlet.id, roleId: role.id } });
      const login = await jsonResponse(await fetch(`${api}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp }, body: JSON.stringify({ tenantSlug: tenant.slug, email, password }) }));
      assert.equal(login.status, 200, JSON.stringify(login.body));
      return { user, headers: headersFor(login.body.accessToken) };
    };
    const manager = await makeStaff('RESTAURANT_MANAGER', 'Manager');
    const waiter = await makeStaff('WAITER', 'Waiter');

    assert.equal((await fetch(`${api}/api/kds?outletId=${outlet.id}`)).status, 401);
    assert.equal((await fetch(`${api}/api/kds?outletId=${outlet.id}`, { headers: waiter.headers })).status, 403);
    assert.equal((await fetch(`${api}/api/outlet-settings?outletId=${outlet.id}`, { headers: waiter.headers })).status, 403);
    const noStationAccess = await fetch(`${api}/api/kds/stations`, { method: 'POST', headers: { ...waiter.headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, name: 'Waiter station' }) });
    assert.equal(noStationAccess.status, 403);

    const otherTenant = await prisma.tenant.create({ data: { name: `Other KDS ${suffix}`, slug: `other-kds-${suffix}` } });
    tenants.push(otherTenant.id);
    const otherOutlet = await prisma.outlet.create({ data: { tenantId: otherTenant.id, name: 'Other outlet', code: 'OTHER' } });
    assert.equal((await fetch(`${api}/api/kds?outletId=${otherOutlet.id}`, { headers: manager.headers })).status, 403);

    const stationsResponse = await jsonResponse(await fetch(`${api}/api/kds/stations`, { method: 'POST', headers: { ...manager.headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, name: 'Hot Line' }) }));
    assert.equal(stationsResponse.status, 201, JSON.stringify(stationsResponse.body));
    assert.equal((await fetch(`${api}/api/outlet-settings?outletId=${outlet.id}`, { headers: manager.headers })).status, 403);
    const columnSettings = await jsonResponse(await fetch(`${api}/api/outlet-settings`, { method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, kdsColumnsByStation: { all: ['QUEUED', 'READY'], [stationsResponse.body.id]: ['PREPARING', 'READY'] } }) }));
    assert.equal(columnSettings.status, 200, JSON.stringify(columnSettings.body));
    assert.deepEqual(columnSettings.body.settings.kdsColumnsByStation[stationsResponse.body.id], ['PREPARING', 'READY']);
    const invalidColumnSettings = await fetch(`${api}/api/outlet-settings`, { method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, kdsColumnsByStation: { [otherOutlet.id]: ['READY'] } }) });
    assert.equal(invalidColumnSettings.status, 400);
    const menu = await jsonResponse(await fetch(`${api}/api/menu?outletId=${outlet.id}`, { headers: manager.headers }));
    assert.equal(menu.status, 200);
    const item = menu.body.flatMap((category) => category.items).find((entry) => entry.name === 'Masala Dosa');
    assert.ok(item);
    const routing = await jsonResponse(await fetch(`${api}/api/kds/stations`, { method: 'PATCH', headers: { ...manager.headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, menuItemId: item.id, stationId: stationsResponse.body.id }) }));
    assert.equal(routing.status, 200, JSON.stringify(routing.body));

    const order = await jsonResponse(await fetch(`${api}/api/orders`, { method: 'POST', headers: { ...manager.headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, clientMutationId: `kds-order-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }] }) }));
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(order.body.kot.stationId, stationsResponse.body.id);
    const ticketId = order.body.kot.id;
    const secondItem = menu.body.flatMap((category) => category.items).find((entry) => entry.name === 'Idli Sambar');
    assert.ok(secondItem);
    const followup = await jsonResponse(await fetch(`${api}/api/orders/${order.body.order.id}/items`, { method: 'POST', headers: { ...manager.headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, clientMutationId: `kds-add-${suffix}`, items: [{ menuItemId: secondItem.id, quantity: 2 }] }) }));
    assert.equal(followup.status, 201, JSON.stringify(followup.body));
    assert.equal(followup.body.kotIds.length, 1);
    const addedKot = await prisma.kOT.findUniqueOrThrow({ where: { id: followup.body.kotIds[0] }, include: { station: true } });
    assert.equal(addedKot.orderId, order.body.order.id);
    assert.equal(addedKot.station.name, 'General');
    assert.equal(addedKot.sequence, 2);
    const addReplay = await fetch(`${api}/api/orders/${order.body.order.id}/items`, { method: 'POST', headers: { ...manager.headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: outlet.id, clientMutationId: `kds-add-${suffix}`, items: [{ menuItemId: secondItem.id, quantity: 2 }] }) });
    assert.equal((await addReplay.json()).replayed, true);

    const readTickets = async (query = '') => jsonResponse(await fetch(`${api}/api/kds?outletId=${outlet.id}${query}`, { headers: manager.headers }));
    let board = await readTickets();
    assert.equal(board.status, 200, JSON.stringify(board.body));
    let ticket = board.body.tickets.find((entry) => entry.id === ticketId);
    assert.ok(ticket);
    assert.equal(ticket.station.name, 'Hot Line');
    assert.equal(ticket.items[0].state, 'QUEUED');

    const postAction = async (action, extra = {}, clientMutationId = randomUUID(), actionTicketId = ticketId) => jsonResponse(await fetch(`${api}/api/kds/actions`, {
      method: 'POST', headers: { ...manager.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: outlet.id, ticketId: actionTicketId, action, clientMutationId, ...extra }),
    }));
    const firstPayload = { itemId: ticket.items[0].id, expectedUpdatedAt: ticket.items[0].updatedAt };
    const mutationId = randomUUID();
    const cooking = await postAction('item-cycle', firstPayload, mutationId);
    assert.equal(cooking.status, 200, JSON.stringify(cooking.body));
    assert.equal(cooking.body.status, 'PREPARING');
    assert.equal(cooking.body.items[0].state, 'COOKING');
    assert.equal((await postAction('item-cycle', firstPayload, mutationId)).body.replayed, true);
    const reusedId = await postAction('start-all', {}, mutationId);
    assert.equal(reusedId.status, 409, 'a mutation key cannot authorize a different action');
    assert.equal((await postAction('item-cycle', firstPayload)).status, 409, 'stale item versions are rejected');

    board = await readTickets(); ticket = board.body.tickets.find((entry) => entry.id === ticketId);
    const ready = await postAction('item-cycle', { itemId: ticket.items[0].id, expectedUpdatedAt: ticket.items[0].updatedAt });
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.status, 'READY');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.body.order.id } })).status, 'PREPARING', 'an order stays preparing while another station ticket is queued');
    board = await readTickets();
    const sibling = board.body.tickets.find((entry) => entry.id !== ticketId);
    assert.ok(sibling);
    let siblingResult = await postAction('item-cycle', { itemId: sibling.items[0].id, expectedUpdatedAt: sibling.items[0].updatedAt }, randomUUID(), sibling.id);
    assert.equal(siblingResult.status, 200, JSON.stringify(siblingResult.body));
    siblingResult = await postAction('item-cycle', { itemId: siblingResult.body.items[0].id, expectedUpdatedAt: siblingResult.body.items[0].updatedAt }, randomUUID(), sibling.id);
    assert.equal(siblingResult.body.status, 'READY');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.body.order.id } })).status, 'READY');

    assert.equal((await postAction('hold', { reason: 'x' })).status, 400);
    assert.equal((await postAction('hold', { reason: 'Waiting for guest' })).status, 200);
    board = await readTickets(); ticket = board.body.tickets.find((entry) => entry.id === ticketId);
    assert.ok(ticket.heldAt);
    assert.equal((await postAction('item-cycle', { itemId: ticket.items[0].id, expectedUpdatedAt: ticket.items[0].updatedAt })).status, 409);
    assert.equal((await postAction('resume')).status, 200);

    const bumped = await postAction('bump-ticket');
    assert.equal(bumped.status, 200, JSON.stringify(bumped.body));
    assert.equal(bumped.body.status, 'SERVED');
    assert.ok(bumped.body.undoBumpUntil);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.body.order.id } })).status, 'READY', 'one served station ticket does not complete the whole order');
    assert.equal((await postAction('undo-bump')).body.status, 'READY');
    assert.equal((await postAction('bump-ticket')).body.status, 'SERVED');
    board = await readTickets('&includeServed=1');
    ticket = board.body.tickets.find((entry) => entry.id === ticketId);
    assert.equal((await postAction('recall')).body.status, 'READY');

    board = await readTickets(); ticket = board.body.tickets.find((entry) => entry.id === ticketId);
    const outOfStock = await postAction('item-86', { itemId: ticket.items[0].id, expectedUpdatedAt: ticket.items[0].updatedAt });
    assert.equal(outOfStock.status, 200, JSON.stringify(outOfStock.body));
    assert.equal(outOfStock.body.items[0].state, 'OUT_OF_STOCK');
    assert.equal((await prisma.outletMenuItem.findUnique({ where: { outletId_menuItemId: { outletId: outlet.id, menuItemId: item.id } } })).available, false);

    const print = await fetch(`${api}/api/kds/tickets/${ticketId}/reprint?outletId=${outlet.id}`, { headers: manager.headers });
    assert.equal(print.status, 200);
    assert.equal(print.headers.get('content-type'), 'application/vnd.kora.escpos');
    const printBytes = new Uint8Array(await print.arrayBuffer());
    assert.equal(printBytes[0], 0x1b);
    assert.equal(printBytes[1], 0x40);
    const audit = await prisma.auditLog.findMany({ where: { outletId: outlet.id, entityId: { in: [ticketId, ticket.items[0].id] } }, select: { action: true } });
    assert.ok(audit.some((entry) => entry.action === 'KDS_RECALL'));
    assert.ok(audit.some((entry) => entry.action === 'KDS_ITEM_86'));
    assert.ok(audit.some((entry) => entry.action === 'KOT_REPRINTED'));

    const metrics = await jsonResponse(await fetch(`${api}/api/kds/metrics?outletId=${outlet.id}`, { headers: manager.headers }));
    assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
    assert.ok(Array.isArray(metrics.body.stations));
    assert.ok(Array.isArray(metrics.body.hourly));
  } finally {
    if (tenants.length) await prisma.tenant.deleteMany({ where: { id: { in: tenants } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
