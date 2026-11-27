import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { PrismaClient } from '@prisma/client';
import { accessTokenSigningKey } from '../src/lib/jwt-secret.ts';

const api = process.env.KORA_SECURITY_TEST_URL;
const enabled = Boolean(api && process.env.DATABASE_URL && process.env.JWT_ACCESS_SECRET);

test('purchase receipts are tenant-scoped, idempotent, audited, paginated, and atomic with weighted stock costing', { skip: !enabled, timeout: 60000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  let foreignTenantId;
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenant = await prisma.tenant.create({ data: { name: `Purchases ${suffix}`, slug: `purchases-${suffix}` } });
    tenantId = tenant.id;
    const outlet = await prisma.outlet.create({ data: { tenantId, name: 'Receipt outlet', code: `PR-${suffix}` } });
    const secondOutlet = await prisma.outlet.create({ data: { tenantId, name: 'Second receipt outlet', code: `PS-${suffix}` } });
    const owner = await prisma.user.create({ data: { tenantId, name: 'Inventory owner', email: `purchase-owner-${suffix}@example.test`, passwordHash: 'unused-test-password-hash' } });
    const permissions = await prisma.permission.findMany({ where: { key: { in: ['inventory.view', 'inventory.adjust'] } }, select: { id: true } });
    assert.equal(permissions.length, 2, 'inventory permissions must be seeded');
    const ownerRole = await prisma.role.create({ data: { tenantId, name: `PURCHASE_OWNER_${suffix}`, description: 'Purchase integration test role', permissions: { create: permissions.map(({ id }) => ({ permissionId: id })) } } });
    await prisma.userOutletRole.createMany({ data: [outlet, secondOutlet].map(({ id }) => ({ userId: owner.id, outletId: id, roleId: ownerRole.id })) });

    const viewer = await prisma.user.create({ data: { tenantId, name: 'Inventory viewer', email: `purchase-viewer-${suffix}@example.test`, passwordHash: 'unused-test-password-hash' } });
    const inventoryView = await prisma.permission.findUniqueOrThrow({ where: { key: 'inventory.view' }, select: { id: true } });
    const viewerRole = await prisma.role.create({ data: { tenantId, name: `PURCHASE_VIEWER_${suffix}`, description: 'Read-only inventory role', permissions: { create: [{ permissionId: inventoryView.id }] } } });
    await prisma.userOutletRole.create({ data: { userId: viewer.id, outletId: outlet.id, roleId: viewerRole.id } });

    const tokenFor = (userId) => new SignJWT({ tenantId })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('5m')
      .sign(accessTokenSigningKey(process.env.JWT_ACCESS_SECRET));
    const ownerHeaders = { authorization: `Bearer ${await tokenFor(owner.id)}`, 'content-type': 'application/json' };
    const viewerHeaders = { authorization: `Bearer ${await tokenFor(viewer.id)}`, 'content-type': 'application/json' };
    const vendor = await prisma.vendor.create({ data: { tenantId, name: `Fresh supplier ${suffix}` } });
    const inactiveVendor = await prisma.vendor.create({ data: { tenantId, name: `Inactive supplier ${suffix}`, active: false } });
    const rice = await prisma.rawMaterial.create({ data: { tenantId, outletId: outlet.id, name: `Rice ${suffix}`, unit: 'kg', quantityMilli: 2500n, costPerUnitPaise: 8000n } });
    const salt = await prisma.rawMaterial.create({ data: { tenantId, outletId: outlet.id, name: `Salt ${suffix}`, unit: 'kg', quantityMilli: 0n, costPerUnitPaise: 0n } });
    const secondOutletMaterial = await prisma.rawMaterial.create({ data: { tenantId, outletId: secondOutlet.id, name: `Other rice ${suffix}`, unit: 'kg' } });

    const receiptBody = {
      outletId: outlet.id,
      vendorId: vendor.id,
      reference: `INV-${suffix}-1`,
      clientMutationId: randomUUID(),
      lines: [
        { rawMaterialId: rice.id, quantityMilli: '1000', unitCostPaise: '10000' },
        { rawMaterialId: salt.id, quantityMilli: '500', unitCostPaise: '500' },
      ],
    };
    const createReceipt = (body, headers = ownerHeaders) => fetch(`${api}/api/inventory/purchases`, { method: 'POST', headers, body: JSON.stringify(body) });
    const createdResponse = await createReceipt(receiptBody);
    const createdBody = await createdResponse.json();
    assert.equal(createdResponse.status, 201, JSON.stringify(createdBody));
    assert.equal(createdBody.replayed, false);
    assert.equal(createdBody.purchase.totalPaise, '10250', 'server computes the sum of receipt lines in paise');
    assert.equal(createdBody.purchase.status, 'RECEIVED');
    assert.equal(createdBody.purchase.idempotencyKey, undefined, 'internal idempotency details are never returned');
    assert.equal(createdBody.purchase.idempotencyPayloadHash, undefined);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rice.id } })).quantityMilli, 3500n);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rice.id } })).costPerUnitPaise, 8571n, 'weighted-average unit cost is rounded half-up in paise');
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: salt.id } })).quantityMilli, 500n);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: salt.id } })).costPerUnitPaise, 500n);
    assert.equal(await prisma.stockMovement.count({ where: { outletId: outlet.id, referenceId: createdBody.purchase.id, type: 'PURCHASE' } }), 2);
    const receiptAudit = await prisma.auditLog.findFirst({ where: { tenantId, outletId: outlet.id, action: 'INVENTORY_PURCHASE_RECEIVED', entityId: createdBody.purchase.id } });
    assert.equal(receiptAudit?.after?.totalPaise, '10250');

    const replayResponse = await createReceipt(receiptBody);
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.purchase.id, createdBody.purchase.id);
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rice.id } })).quantityMilli, 3500n, 'retry never applies stock twice');
    assert.equal(await prisma.stockMovement.count({ where: { outletId: outlet.id, referenceId: createdBody.purchase.id, type: 'PURCHASE' } }), 2);
    const changedPayload = await createReceipt({ ...receiptBody, lines: [{ ...receiptBody.lines[0], unitCostPaise: '9000' }, receiptBody.lines[1]] });
    assert.equal(changedPayload.status, 409, 'a request key cannot be reused for changed supplier costs');

    const invalidLines = await createReceipt({ ...receiptBody, clientMutationId: randomUUID(), lines: [receiptBody.lines[0], receiptBody.lines[0]] });
    assert.equal(invalidLines.status, 400, 'duplicate material lines are rejected rather than costed ambiguously');
    const zeroQuantity = await createReceipt({ ...receiptBody, clientMutationId: randomUUID(), lines: [{ ...receiptBody.lines[0], quantityMilli: '0' }] });
    assert.equal(zeroQuantity.status, 400);
    const inactiveSupplier = await createReceipt({ ...receiptBody, vendorId: inactiveVendor.id, clientMutationId: randomUUID() });
    assert.equal(inactiveSupplier.status, 404);
    const foreignIngredient = await createReceipt({ ...receiptBody, clientMutationId: randomUUID(), lines: [{ rawMaterialId: secondOutletMaterial.id, quantityMilli: '1000', unitCostPaise: '100' }] });
    assert.equal(foreignIngredient.status, 404, 'ingredient IDs from a sibling outlet never enter a receipt');
    const forbidden = await createReceipt({ ...receiptBody, clientMutationId: randomUUID() }, viewerHeaders);
    assert.equal(forbidden.status, 403, 'inventory.view alone cannot record stock receipts');

    const secondReceiptBody = {
      outletId: outlet.id,
      vendorId: vendor.id,
      reference: `INV-${suffix}-2`,
      clientMutationId: randomUUID(),
      lines: [{ rawMaterialId: rice.id, quantityMilli: '500', unitCostPaise: '12000' }],
    };
    const secondReceiptResponse = await createReceipt(secondReceiptBody);
    assert.equal(secondReceiptResponse.status, 201);
    const secondReceipt = await secondReceiptResponse.json();
    const afterSecondReceipt = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: rice.id } });
    assert.equal(afterSecondReceipt.quantityMilli, 4000n);
    assert.equal(afterSecondReceipt.costPerUnitPaise, 9000n);

    const firstPageResponse = await fetch(`${api}/api/inventory/purchases?outletId=${outlet.id}&limit=1`, { headers: ownerHeaders });
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPageResponse.status, 200);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].id, secondReceipt.purchase.id, 'receipt history is ordered newest first');
    assert.equal(firstPage.nextCursor, secondReceipt.purchase.id);
    const nextPageResponse = await fetch(`${api}/api/inventory/purchases?outletId=${outlet.id}&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: ownerHeaders });
    const nextPage = await nextPageResponse.json();
    assert.equal(nextPageResponse.status, 200);
    assert.equal(nextPage.items.length, 1);
    assert.equal(nextPage.items[0].id, createdBody.purchase.id);
    assert.equal(nextPage.nextCursor, null);
    const foreignCursor = await fetch(`${api}/api/inventory/purchases?outletId=${secondOutlet.id}&cursor=${encodeURIComponent(createdBody.purchase.id)}`, { headers: ownerHeaders });
    assert.equal(foreignCursor.status, 400, 'purchase cursors are bound to the selected outlet');
    const invalidPageSize = await fetch(`${api}/api/inventory/purchases?outletId=${outlet.id}&limit=0`, { headers: ownerHeaders });
    assert.equal(invalidPageSize.status, 400);

    const concurrentKey = randomUUID();
    const concurrentBody = { outletId: outlet.id, clientMutationId: concurrentKey, lines: [{ rawMaterialId: salt.id, quantityMilli: '1000', unitCostPaise: '10000' }] };
    const duplicateRace = await Promise.all([createReceipt(concurrentBody), createReceipt(concurrentBody)]);
    const duplicateRaceBodies = await Promise.all(duplicateRace.map((response) => response.json()));
    assert.deepEqual(duplicateRace.map((response) => response.status).sort(), [200, 201], JSON.stringify(duplicateRaceBodies));
    assert.equal((await prisma.rawMaterial.findUniqueOrThrow({ where: { id: salt.id } })).quantityMilli, 1500n);
    const concurrentPurchases = await prisma.purchase.findMany({ where: { outletId: outlet.id, idempotencyKey: concurrentKey } });
    assert.equal(concurrentPurchases.length, 1);
    assert.equal(await prisma.stockMovement.count({ where: { outletId: outlet.id, referenceId: concurrentPurchases[0].id, type: 'PURCHASE' } }), 1);

    const butter = await prisma.rawMaterial.create({ data: { tenantId, outletId: outlet.id, name: `Butter ${suffix}`, unit: 'kg' } });
    const concurrentStockBodies = [4000, 6000].map((unitCostPaise) => ({ outletId: outlet.id, clientMutationId: randomUUID(), lines: [{ rawMaterialId: butter.id, quantityMilli: '1000', unitCostPaise: String(unitCostPaise) }] }));
    const stockRaceResponses = await Promise.all(concurrentStockBodies.map((body) => createReceipt(body)));
    assert.ok(stockRaceResponses.every((response) => response.status === 201 || response.status === 409), `unexpected concurrent stock statuses: ${stockRaceResponses.map(({ status }) => status)}`);
    for (let index = 0; index < stockRaceResponses.length; index++) {
      if (stockRaceResponses[index].status === 409) assert.equal((await createReceipt(concurrentStockBodies[index])).status, 201, 'serialization conflicts can be retried with the same request ID');
    }
    const butterAfterConcurrentReceipts = await prisma.rawMaterial.findUniqueOrThrow({ where: { id: butter.id } });
    assert.equal(butterAfterConcurrentReceipts.quantityMilli, 2000n, 'concurrent receipts cannot lose received quantities');
    assert.equal(butterAfterConcurrentReceipts.costPerUnitPaise, 5000n, 'serially reconciled receipts produce the exact blended cost');

    foreignTenantId = (await prisma.tenant.create({ data: { name: `Foreign Purchase ${suffix}`, slug: `foreign-purchase-${suffix}` } })).id;
    const foreignVendor = await prisma.vendor.create({ data: { tenantId: foreignTenantId, name: `Foreign supplier ${suffix}` } });
    const crossTenantVendor = await createReceipt({ ...receiptBody, vendorId: foreignVendor.id, clientMutationId: randomUUID() });
    assert.equal(crossTenantVendor.status, 404, 'a vendor from another tenant cannot be attached to an outlet receipt');
    const noAccess = await fetch(`${api}/api/inventory/purchases?outletId=${outlet.id}`, { headers: { 'content-type': 'application/json' } });
    assert.equal(noAccess.status, 401);
  } finally {
    if (foreignTenantId) await prisma.tenant.deleteMany({ where: { id: foreignTenantId } }).catch(() => undefined);
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
