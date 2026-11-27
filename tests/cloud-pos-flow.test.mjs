import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

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
    const taxProfileResponse = await fetch(`${api}/api/outlet-profile`, {
      method: 'PATCH', headers: { authorization: `Bearer ${registration.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, outletName: 'Test Outlet', gstin: '29ABCDE1234F1Z5', gstProfile: 'STANDARD_RESTAURANT', gstRateBps: 500, fssaiLicense: '', address: { line1: '12 Main Road', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' } }),
    });
    assert.equal(taxProfileResponse.status, 200, await taxProfileResponse.text());

    const loginResponse = await fetch(`${api}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantSlug: registration.tenant.slug, email, password }),
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200, JSON.stringify(login));
    assert.ok(login.accessToken);
    assert.match(loginResponse.headers.get('set-cookie') ?? '', /HttpOnly/);
    const ownerHeaders = { authorization: `Bearer ${login.accessToken}` };

    const sessionResponse = await fetch(`${api}/api/auth/me`, { headers: ownerHeaders });
    const session = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);
    assert.equal(session.user.id, registration.user.id);
    assert.ok(session.outlets[0].permissions.includes('orders.create') === false, 'owner should not receive day-to-day order-taking access');
    assert.ok(session.outlets[0].permissions.includes('roles.manage'));
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: registration.tenant.id, name: 'RESTAURANT_MANAGER' } } });
    const managerEmail = `manager-${suffix}@example.test`;
    const manager = await prisma.user.create({ data: { tenantId, name: 'POS Test Manager', email: managerEmail, passwordHash: await hash('ManagerTest123!Secure', 4) } });
    await prisma.userOutletRole.create({ data: { userId: manager.id, outletId: registration.outlet.id, roleId: managerRole.id } });
    const managerLoginResponse = await fetch(`${api}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantSlug: registration.tenant.slug, email: managerEmail, password: 'ManagerTest123!Secure' }),
    });
    const managerLogin = await managerLoginResponse.json();
    assert.equal(managerLoginResponse.status, 200, JSON.stringify(managerLogin));
    const headers = { authorization: `Bearer ${managerLogin.accessToken}` };

    const menuResponse = await fetch(`${api}/api/menu?outletId=${registration.outlet.id}`, { headers });
    const categories = await menuResponse.json();
    assert.equal(menuResponse.status, 200);
    assert.equal(categories.length, 5);
    const item = categories.flatMap((category) => category.items)[0];
    assert.ok(item?.id);
    const unclassifiedSale = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `missing-tax-code-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    });
    assert.equal(unclassifiedSale.status, 409, 'a registered Tax Invoice cannot be issued with an unclassified menu item');
    const sampleClassificationResponse = await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: item.id, taxCodeKind: 'SAC', taxCode: '996331' }),
    });
    assert.equal(sampleClassificationResponse.status, 200, await sampleClassificationResponse.text());
    await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: item.id, taxCodeKind: 'HSN', taxCode: '21069099' }),
    });
    const deliveryWithoutAddress = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `delivery-no-address-${suffix}`, type: 'Delivery', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    });
    assert.equal(deliveryWithoutAddress.status, 400, 'packaged-goods delivery needs a destination address');
    const interstateDelivery = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `delivery-interstate-${suffix}`, type: 'Delivery', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0, buyerDetails: { address: { line1: '1 Lake Road', city: 'Hyderabad', state: 'Telangana', pincode: '500001' } } }),
    });
    assert.equal(interstateDelivery.status, 409, 'inter-state packaged-goods delivery must not receive an incorrect local tax split');
    const restoreServiceCode = await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: item.id, taxCodeKind: 'SAC', taxCode: '996331' }),
    });
    assert.equal(restoreServiceCode.status, 200);
    await prisma.outlet.update({ where: { id: registration.outlet.id }, data: { serviceChargeBps: 500 } });
    const menuCreateResponse = await fetch(`${api}/api/menu`, {
      method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, categoryId: categories[0].id, name: `Cloud special ${suffix}`, pricePaise: 7650, taxCodeKind: 'SAC', taxCode: '996331' }),
    });
    const addedMenuItem = await menuCreateResponse.json();
    assert.equal(menuCreateResponse.status, 201, JSON.stringify(addedMenuItem));
    assert.equal(addedMenuItem.gstBps, null, 'new menu items inherit the tenant rate until a tax override is set');
    const menuTaxUpdateResponse = await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: addedMenuItem.id, gstBps: 1200 }),
    });
    const menuTaxUpdate = await menuTaxUpdateResponse.json();
    assert.equal(menuTaxUpdateResponse.status, 200, JSON.stringify(menuTaxUpdate));
    assert.equal(menuTaxUpdate.gstBps, 1200);
    const taxAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: registration.outlet.id, action: 'MENU_TAX_RATE_CHANGED', entityId: addedMenuItem.id } });
    assert.equal(taxAudit?.after?.gstBps, 1200);
    const effectiveMenu = await (await fetch(`${api}/api/menu?outletId=${registration.outlet.id}`, { headers })).json();
    assert.equal(effectiveMenu.flatMap(({ items }) => items).find(({ id }) => id === addedMenuItem.id).gstBps, 1200);

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
    const recipeMaterial = await prisma.rawMaterial.create({ data: { tenantId, outletId: registration.outlet.id, name: `Sale rice ${suffix}`, unit: 'kg', quantityMilli: 1000n, reorderMilli: 500n } });
    const saleRecipe = await prisma.recipe.create({ data: { tenantId, outletId: registration.outlet.id, menuItemId: item.id, yieldQuantity: 2, ingredients: { create: [{ rawMaterialId: recipeMaterial.id, quantityMilli: 1500n }] } } });
    const orderPayload = {
      outletId: registration.outlet.id, clientMutationId, deviceId: `device-${suffix}`,
      type: 'Dine in', tableId: firstTable.id, items: [{ menuItemId: item.id, quantity: 2 }],
      paidPaise: 0, discountBps: 0,
      buyerDetails: { name: 'Aarav Shah', gstin: '29ABCDE1234F1Z5', address: { line1: '20 Main Road', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' } },
    };
    const blockedForShortage = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...orderPayload, clientMutationId: `short-stock-${suffix}` }),
    });
    const shortageResponse = await blockedForShortage.json();
    assert.equal(blockedForShortage.status, 409, JSON.stringify(shortageResponse));
    assert.equal(shortageResponse.shortages[0].material, recipeMaterial.name);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 1000n, 'blocked sales must leave stock unchanged');
    await prisma.rawMaterial.update({ where: { id: recipeMaterial.id }, data: { quantityMilli: 3000n } });
    const wrongBuyerStateResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...orderPayload, clientMutationId: `bad-buyer-${suffix}`, buyerDetails: { ...orderPayload.buyerDetails, gstin: '27ABCDE1234F1Z5' } }),
    });
    assert.equal(wrongBuyerStateResponse.status, 400);
    const concurrentOrderResponses = await Promise.all([1, 2].map(() => fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(orderPayload),
    })));
    const concurrentOrderBodies = await Promise.all(concurrentOrderResponses.map((response) => response.json()));
    assert.deepEqual(concurrentOrderResponses.map((response) => response.status).sort(), [200, 201], JSON.stringify(concurrentOrderBodies));
    const createdIndex = concurrentOrderResponses.findIndex((response) => response.status === 201);
    const replayIndex = 1 - createdIndex;
    const created = concurrentOrderBodies[createdIndex];
    assert.equal(concurrentOrderBodies[replayIndex].replayed, true);
    assert.equal(concurrentOrderBodies[replayIndex].order.id, created.order.id);
    assert.equal(created.order.items.length, 1);
    assert.equal(created.order.items[0].quantity, 2);
    assert.equal(created.kot.sequence, 1);
    assert.equal(created.bill.paymentStatus, 'PENDING');
    assert.equal(created.bill.documentType, 'TAX_INVOICE');
    assert.ok(created.bill.invoiceNumber.length <= 16, 'GST invoice serial stays within the 16-character limit');
    assert.equal(created.bill.gstProfile, 'STANDARD_RESTAURANT');
    assert.equal(created.bill.gstinSnapshot, '29ABCDE1234F1Z5');
    assert.equal(created.bill.recipientNameSnapshot, 'Aarav Shah');
    assert.equal(created.bill.recipientGstinSnapshot, '29ABCDE1234F1Z5');
    assert.equal(created.order.items[0].taxCodeKindSnapshot, 'SAC');
    assert.equal(created.order.items[0].taxCodeSnapshot, '996331');
    assert.equal(Object.hasOwn(created.order, 'idempotencyPayloadHash'), false, 'internal request hashes must not be returned to POS clients');
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 1500n, 'recipe stock is deducted atomically with the order');
    const saleMovement = await prisma.stockMovement.findFirst({ where: { outletId: registration.outlet.id, referenceId: created.order.items[0].id, type: 'SALE' } });
    assert.equal(saleMovement?.quantityMilli, -1500n);
    assert.equal(saleMovement?.recipeYieldQuantity, 2);
    assert.equal(saleMovement?.recipeIngredientQuantityMilli, 1500n);
    assert.equal(saleMovement?.recipeQuantityBefore, 0n);
    assert.equal(created.bill.supplierNameSnapshot, registration.tenant.name);
    const unitPricePaise = BigInt(item.outletPrices[0]?.pricePaise ?? item.basePricePaise);
    const expectedSubtotalPaise = unitPricePaise * 2n;
    const expectedServiceChargePaise = (expectedSubtotalPaise * 500n + 5000n) / 10000n;
    const expectedTaxablePaise = expectedSubtotalPaise + expectedServiceChargePaise;
    const expectedTaxPaise = (expectedTaxablePaise * BigInt(item.gstBps) + 5000n) / 10000n;
    assert.equal(created.bill.taxablePaise, expectedTaxablePaise.toString());
    assert.equal(created.bill.serviceChargePaise, expectedServiceChargePaise.toString());
    assert.equal((BigInt(created.bill.cgstPaise) + BigInt(created.bill.sgstPaise)).toString(), expectedTaxPaise.toString());
    assert.equal(created.bill.totalPaise, (expectedTaxablePaise + expectedTaxPaise).toString());

    await fetch(`${api}/api/menu`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, menuItemId: item.id, taxCodeKind: 'HSN', taxCode: '21069099' }),
    });
    const invoiceResponse = await fetch(`${api}/api/bills/${created.bill.id}/invoice?outletId=${registration.outlet.id}`, { headers });
    const invoice = await invoiceResponse.json();
    assert.equal(invoiceResponse.status, 200, JSON.stringify(invoice));
    assert.equal(invoice.documentType, 'TAX_INVOICE');
    assert.equal(invoice.recipientGstin, '29ABCDE1234F1Z5');
    assert.equal(invoice.placeOfSupply, 'Karnataka');
    assert.equal(invoice.lines[0].taxCode, '996331', 'printed line retains the code snapshot even after menu reclassification');
    assert.equal(invoice.taxBreakdown[0].gstBps, 500);
    assert.equal(invoice.totals.totalPaise, created.bill.totalPaise);

    const replayResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(orderPayload),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.order.id, created.order.id);
    assert.equal(Object.hasOwn(replay.order, 'idempotencyPayloadHash'), false, 'replay responses must not expose internal hashes');
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 1500n, 'idempotent order replay must not deduct stock again');
    assert.equal(await prisma.order.count({ where: { tenantId } }), 1);
    const mutationIdCollision = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...orderPayload, items: [{ menuItemId: item.id, quantity: 1 }] }),
    });
    assert.equal(mutationIdCollision.status, 409, 'reusing an idempotency key with a different request must conflict');
    assert.equal(await prisma.order.count({ where: { tenantId } }), 1, 'a conflicting idempotency-key reuse must not create or alter an order');

    const queuedVoidResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `void-queued-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    });
    const queuedVoidOrder = await queuedVoidResponse.json();
    assert.equal(queuedVoidResponse.status, 201, JSON.stringify(queuedVoidOrder));
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 750n);
    await prisma.recipeIngredient.update({ where: { recipeId_rawMaterialId: { recipeId: saleRecipe.id, rawMaterialId: recipeMaterial.id } }, data: { quantityMilli: 3000n } });
    const queuedVoid = await fetch(`${api}/api/orders/${queuedVoidOrder.order.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: registration.outlet.id, action: 'void', reason: 'Guest cancelled before prep' }) });
    assert.equal(queuedVoid.status, 200, await queuedVoid.text());
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 1500n, 'void restores from the sale-time BOM snapshot after recipe edits');
    assert.equal(await prisma.stockMovement.count({ where: { outletId: registration.outlet.id, referenceId: queuedVoidOrder.order.id, type: 'SALE_REVERSAL' } }), 1);
    await prisma.recipeIngredient.update({ where: { recipeId_rawMaterialId: { recipeId: saleRecipe.id, rawMaterialId: recipeMaterial.id } }, data: { quantityMilli: 1500n } });

    const queuedMaterial = await prisma.rawMaterial.create({ data: { tenantId, outletId: registration.outlet.id, name: `Queued portion ${suffix}`, unit: 'g', quantityMilli: 1000n } });
    await prisma.recipe.create({ data: { tenantId, outletId: registration.outlet.id, menuItemId: addedMenuItem.id, yieldQuantity: 2, ingredients: { create: [{ rawMaterialId: queuedMaterial.id, quantityMilli: 1000n }] } } });
    const mixedVoidResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `void-mixed-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 2 }, { menuItemId: addedMenuItem.id, quantity: 2 }], paidPaise: 0 }),
    });
    const mixedVoidOrder = await mixedVoidResponse.json();
    assert.equal(mixedVoidResponse.status, 201, JSON.stringify(mixedVoidOrder));
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 0n);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: queuedMaterial.id } })).quantityMilli, 0n);
    const startedOrderItem = mixedVoidOrder.order.items.find(({ menuItemId }) => menuItemId === item.id);
    const startedKot = mixedVoidOrder.kots.find(({ items }) => items.some(({ orderItemId }) => orderItemId === startedOrderItem.id));
    const startedKotItem = startedKot.items.find(({ orderItemId }) => orderItemId === startedOrderItem.id);
    const startMixedKitchen = await fetch(`${api}/api/kds/actions`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, ticketId: startedKot.id, itemId: startedKotItem.id, action: 'item-cycle', clientMutationId: `start-mixed-${suffix}` }),
    });
    assert.equal(startMixedKitchen.status, 200, await startMixedKitchen.text());
    const mixedVoid = await fetch(`${api}/api/orders/${mixedVoidOrder.order.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: registration.outlet.id, action: 'void', reason: 'Guest cancelled one item before prep' }) });
    assert.equal(mixedVoid.status, 200, await mixedVoid.text());
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 0n, 'cooking item consumption stays deducted');
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: queuedMaterial.id } })).quantityMilli, 1000n, 'queued item consumption is restored');

    await prisma.rawMaterial.update({ where: { id: recipeMaterial.id }, data: { quantityMilli: 1500n } });
    const cookingVoidResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `void-cooking-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 2 }], paidPaise: 0 }),
    });
    const cookingVoidOrder = await cookingVoidResponse.json();
    assert.equal(cookingVoidResponse.status, 201, JSON.stringify(cookingVoidOrder));
    const startedItem = cookingVoidOrder.kot.items[0];
    const startKitchen = await fetch(`${api}/api/kds/actions`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, ticketId: cookingVoidOrder.kot.id, itemId: startedItem.id, action: 'item-cycle', clientMutationId: `start-void-${suffix}` }),
    });
    assert.equal(startKitchen.status, 200, await startKitchen.text());
    const preparedVoid = await fetch(`${api}/api/orders/${cookingVoidOrder.order.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: registration.outlet.id, action: 'void', reason: 'Guest cancelled after prep began' }) });
    assert.equal(preparedVoid.status, 200, await preparedVoid.text());
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 0n, 'void does not restore ingredients for items already cooking');

    await prisma.rawMaterial.update({ where: { id: recipeMaterial.id }, data: { quantityMilli: 750n } });
    const missingKotResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `void-untracked-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    });
    const missingKotOrder = await missingKotResponse.json();
    assert.equal(missingKotResponse.status, 201, JSON.stringify(missingKotOrder));
    await prisma.kOTItem.deleteMany({ where: { kotId: missingKotOrder.kot.id } });
    const untrackedVoid = await fetch(`${api}/api/orders/${missingKotOrder.order.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: registration.outlet.id, action: 'void', reason: 'KOT state missing test' }) });
    assert.equal(untrackedVoid.status, 200, await untrackedVoid.text());
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, 0n, 'missing KOT state must not restore unverified stock');
    const untrackedAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: registration.outlet.id, entityId: missingKotOrder.order.id, action: 'ORDER_VOIDED' } });
    assert.equal(untrackedAudit?.after?.stockUntrackedOrderItems, 1);

    const allowNegativePolicy = await fetch(`${api}/api/outlet-settings`, { method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: registration.outlet.id, stockShortagePolicy: 'ALLOW_NEGATIVE' }) });
    assert.equal(allowNegativePolicy.status, 200, await allowNegativePolicy.text());
    const negativeSaleResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `allow-negative-${suffix}`, type: 'Takeaway', items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 0 }),
    });
    const negativeSale = await negativeSaleResponse.json();
    assert.equal(negativeSaleResponse.status, 201, JSON.stringify(negativeSale));
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: recipeMaterial.id } })).quantityMilli, -750n);
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId, outletId: registration.outlet.id, action: 'STOCK_SHORTAGE_ALLOWED', entityId: negativeSale.order.id } }));
    const blockShortagePolicy = await fetch(`${api}/api/outlet-settings`, { method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ outletId: registration.outlet.id, stockShortagePolicy: 'BLOCK' }) });
    assert.equal(blockShortagePolicy.status, 200);

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
    const listedOrder = orderList.find(({ id }) => id === created.order.id);
    assert.equal(listedOrder?.table.label, firstTable.label);

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

    await prisma.rawMaterial.update({ where: { id: recipeMaterial.id }, data: { quantityMilli: 1500n } });
    const guestOrderPayload = { outletId: registration.outlet.id, clientMutationId: `guest-order-${suffix}`, deviceId: `device-${suffix}`, type: 'Takeaway', customerId: guest.id, items: [{ menuItemId: item.id, quantity: 1 }], paidPaise: 500, paymentMethod: 'Cash' };
    const guestOrderResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(guestOrderPayload),
    });
    const guestOrder = await guestOrderResponse.json();
    assert.equal(guestOrderResponse.status, 201, JSON.stringify(guestOrder));
    assert.equal(guestOrder.bill.paymentStatus, 'PARTIAL');
    const overpaymentResponse = await fetch(`${api}/api/orders/${guestOrder.order.id}/payments`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        outletId: registration.outlet.id,
        deviceId: `device-${suffix}`,
        clientMutationId: `overpayment-${suffix}`,
        amountPaise: Number(guestOrder.order.totalPaise) - 500 + 1,
        method: 'UPI',
      }),
    });
    assert.equal(overpaymentResponse.status, 409);
    const paymentsAfterRejectedOverpayment = await prisma.payment.aggregate({
      where: { billId: guestOrder.bill.id, status: 'PAID' },
      _sum: { amountPaise: true },
    });
    assert.equal(paymentsAfterRejectedOverpayment._sum.amountPaise, 500n, 'rejected overpayment must not enter the payment ledger');
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

    const compositionProfileResponse = await fetch(`${api}/api/outlet-profile`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, outletName: 'Test Outlet', gstin: '29ABCDE1234F1Z5', gstProfile: 'COMPOSITION', gstRateBps: 0, fssaiLicense: '', address: { line1: '12 Main Road', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' } }),
    });
    assert.equal(compositionProfileResponse.status, 200, await compositionProfileResponse.text());
    const compositionMenu = await (await fetch(`${api}/api/menu?outletId=${registration.outlet.id}`, { headers })).json();
    const compositionItem = compositionMenu.flatMap(({ items }) => items).find(({ id }) => id === addedMenuItem.id);
    assert.equal(compositionItem.gstBps, 0, 'composition profile must not expose customer GST on menu items');
    const compositionOrderResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `composition-${suffix}`, deviceId: `device-${suffix}`, type: 'Takeaway', items: [{ menuItemId: addedMenuItem.id, quantity: 1 }], paidPaise: 0 }),
    });
    const compositionOrder = await compositionOrderResponse.json();
    assert.equal(compositionOrderResponse.status, 201, JSON.stringify(compositionOrder));
    assert.equal(compositionOrder.bill.documentType, 'BILL_OF_SUPPLY');
    assert.equal(compositionOrder.bill.gstProfile, 'COMPOSITION');
    assert.equal(BigInt(compositionOrder.bill.cgstPaise) + BigInt(compositionOrder.bill.sgstPaise), 0n);
    assert.equal(compositionOrder.bill.totalPaise, compositionOrder.bill.subtotalPaise);

    const unregisteredProfileResponse = await fetch(`${api}/api/outlet-profile`, {
      method: 'PATCH', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, outletName: 'Test Outlet', gstin: '', gstProfile: 'NOT_REGISTERED', gstRateBps: 0, fssaiLicense: '', address: { line1: '12 Main Road', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' } }),
    });
    assert.equal(unregisteredProfileResponse.status, 200, await unregisteredProfileResponse.text());
    const receiptOrderResponse = await fetch(`${api}/api/orders`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ outletId: registration.outlet.id, clientMutationId: `receipt-${suffix}`, deviceId: `device-${suffix}`, type: 'Takeaway', items: [{ menuItemId: addedMenuItem.id, quantity: 1 }], paidPaise: 0 }),
    });
    const receiptOrder = await receiptOrderResponse.json();
    assert.equal(receiptOrderResponse.status, 201, JSON.stringify(receiptOrder));
    assert.equal(receiptOrder.bill.documentType, 'RECEIPT');
    assert.equal(receiptOrder.bill.gstProfile, 'NOT_REGISTERED');
    assert.equal(BigInt(receiptOrder.bill.cgstPaise) + BigInt(receiptOrder.bill.sgstPaise), 0n);
    assert.equal(receiptOrder.bill.totalPaise, receiptOrder.bill.subtotalPaise);
  } finally {
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }
});
