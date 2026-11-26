import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { io } from 'socket.io-client';

const api = process.env.KORA_SECURITY_TEST_URL;
const realtime = process.env.KORA_SECURITY_TEST_REALTIME_URL;
const enabled = Boolean(api && realtime && process.env.DATABASE_URL);
const testIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(4, 8)}::1`;

test('realtime security integration: socket expires on permission revocation', { skip: !enabled, timeout: 45000 }, async () => {
  const prisma = new PrismaClient();
  let tenantId;
  let socket;
  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const response = await fetch(api + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': testIp },
      body: JSON.stringify({ tenantName: 'Realtime Test ' + suffix, outletName: 'Outlet', name: 'Realtime Owner', email: 'realtime-' + suffix + '@example.test', password: 'LongEnoughPass123!' }),
    });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    tenantId = result.tenant.id;
    const role = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: 'OWNER' } } });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 8000);
      socket = io(realtime, { auth: { accessToken: result.accessToken, outletId: result.outlet.id }, transports: ['websocket'], reconnection: false });
      socket.once('kora:ready', resolve);
      socket.once('connect_error', reject);
    });
    const ack = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Authorized KOT event was not accepted')), 3000);
      socket.once('kora:action-required', (payload) => { clearTimeout(timeout); resolve(payload); });
    });
    socket.emit('kot:ack', { kotId: 'security-test-' + suffix });
    assert.equal((await ack).action, 'kds.bump');

    const permission = await prisma.permission.findUniqueOrThrow({ where: { key: 'kds.bump' } });
    const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: permission.id } });
    const reason = await Promise.race([disconnected, new Promise((resolve) => setTimeout(() => resolve(null), 35_000))]);
    assert.ok(reason, 'socket must disconnect after the permission set changes');
  } finally {
    if (socket) socket.disconnect();
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
