import test from 'node:test';
import assert from 'node:assert/strict';
import { indiaDateBoundary, indiaDateString, parseIndiaReportRange } from '../src/lib/domain/report-dates.ts';

test('India report date boundaries start at midnight IST and use an exclusive next-day end', () => {
  assert.equal(indiaDateBoundary('2026-11-27').toISOString(), '2026-11-26T18:30:00.000Z');
  assert.equal(indiaDateBoundary('2026-11-27', true).toISOString(), '2026-11-27T18:30:00.000Z');
  assert.equal(indiaDateString(new Date('2026-11-26T20:00:00.000Z')), '2026-11-27');
});

test('India report ranges validate calendar dates and preserve the inclusive 93-day cap', () => {
  assert.equal(parseIndiaReportRange('2024-02-29', '2024-02-29').ok, true);
  assert.deepEqual(parseIndiaReportRange('2026-02-29', '2026-02-29'), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseIndiaReportRange('2026-11-27', '2026-11-27'), {
    ok: true,
    startsAt: new Date('2026-11-26T18:30:00.000Z'),
    endsAt: new Date('2026-11-27T18:30:00.000Z'),
  });
  assert.equal(parseIndiaReportRange('2026-01-01', '2026-04-03').ok, true);
  assert.deepEqual(parseIndiaReportRange('2026-01-01', '2026-04-04'), { ok: false, reason: 'too-long' });
});

test('India report ranges reject malformed and reversed values', () => {
  assert.deepEqual(parseIndiaReportRange('2026-1-01', '2026-01-01'), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseIndiaReportRange('2026-02-02', '2026-02-01'), { ok: false, reason: 'invalid' });
});
