import test from 'node:test';
import assert from 'node:assert/strict';
import { exceedsPlanLimit, planLimit } from '../src/lib/domain/plan-limits.ts';

test('plan caps match the approved starter matrix', () => {
  assert.deepEqual({
    freeOutlets: planLimit('FREE', 'outlets'),
    freeUsers: planLimit('FREE', 'users'),
    plusOutlets: planLimit('PLUS', 'outlets'),
    plusUsers: planLimit('PLUS', 'users'),
    proOutlets: planLimit('PRO', 'outlets'),
    proUsers: planLimit('PRO', 'users'),
  }, { freeOutlets: 1, freeUsers: 1, plusOutlets: 1, plusUsers: 10, proOutlets: 10, proUsers: 50 });
});

test('plan cap checks reject full or invalid counts and allow a slot below the cap', () => {
  assert.equal(exceedsPlanLimit('FREE', 'users', 0), false);
  assert.equal(exceedsPlanLimit('FREE', 'users', 1), true);
  assert.equal(exceedsPlanLimit('PLUS', 'users', 9), false);
  assert.equal(exceedsPlanLimit('PLUS', 'users', 10), true);
  assert.equal(exceedsPlanLimit('PRO', 'outlets', 9), false);
  assert.equal(exceedsPlanLimit('PRO', 'outlets', 10), true);
  assert.equal(exceedsPlanLimit('PRO', 'users', -1), true);
  assert.equal(exceedsPlanLimit('PRO', 'users', 1.5), true);
});
