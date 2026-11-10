/** Synthetic receipt replay proves measurement semantics, not real performance targets [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { testTimeBudget } from '../../../../packages/gate/index.js';
import { testTimeBudgetLines } from '../../../../packages/gate/index.js';
import { phasesOf } from '../../../../packages/gate/index.js';
import { receiptLog } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
const NOW = Date.parse('2026-10-27T12:00:00Z');

/** Build explicitly synthetic phase records with waits dominating their small command duration. */
function receipt(kind, index, total, extra = {}) {
  return { at: new Date(NOW - (100 - index) * 1000).toISOString(), kind,
    waitMs: total - 4, admissionMs: 1, setupMs: 1, runMs: 1, evidenceMs: 1,
    slot: { kind: 'ordinary', reason: 'synthetic replay fixture' },
    ...(kind === 'landing' ? { timingOperation: 'landing-gate' } : {}), ...extra };
}

/** Feed alternating complete parent receipts and explicitly excluded fast shard rows. */
function rows() {
  return Array.from({ length: 51 }, (_, index) => [receipt('submit', index, (index + 1) * 1000),
    receipt('landing', index, (index + 1) * 2000),
    receipt('landing', index, 4, { timingOperation: 'landing-shard' })]).flat();
}

test('last fifty parent receipts include waits and use nearest-rank p50 and p90 [C7]', () => {
  const report = testTimeBudget(rows(), NOW);
  assert.equal(report.submit.receipts, 50);
  assert.equal(report.submit.p50Ms, 26000, 'oldest of 51 is dropped before rank selection');
  assert.equal(report.submit.p90Ms, 46000);
  assert.equal(report.landingGate.p50Ms, 52000, 'fast shard rows never substitute for full gate walls');
  assert.equal(report.landingGate.p90Ms, 92000);
  assert.equal(report.submit.known, 50);
  assert.equal(report.submit.sampleMeetsTargets, true, 'only this synthetic sample meets thresholds');
  assert.equal(report.dayOfRealLandings, 'not-asserted');
  assert.match(testTimeBudgetLines(report).join('\n'), /one day of real landings: not asserted/);
});

test('unknown newest receipts remain in the fifty instead of backfilling older fast runs [C7]', () => {
  const replay = rows();
  replay.push(receipt('submit', 52, 10000, { evidenceMs: undefined }));
  replay.push(receipt('landing', 52, 10000, { timingOperation: undefined }));
  const report = testTimeBudget(replay, NOW);
  for (const sample of [report.submit, report.landingGate]) {
    assert.equal(sample.receipts, 50);
    assert.equal(sample.known, 49);
    assert.equal(sample.unknown, 1);
    assert.equal(sample.p50Ms, null);
    assert.equal(sample.p90Ms, null);
    assert.equal(sample.sampleMeetsTargets, null);
  }
  assert.match(testTimeBudgetLines(report).join('\n'), /p50 UNKNOWN, p90 UNKNOWN/);
});

test('incomplete, malformed and future observations cannot establish a budget achievement [C7]', () => {
  const sparse = testTimeBudget([receipt('submit', 1, 300000)], NOW);
  assert.equal(sparse.submit.sampleMeetsTargets, null);
  assert.equal(sparse.landingGate.p50Ms, null);
  const replay = rows();
  replay.push({ malformed: true });
  const broken = testTimeBudget(replay, NOW);
  assert.equal(broken.submit.unclassified, 1);
  assert.equal(broken.landingGate.unclassified, 1);
  assert.equal(broken.submit.p50Ms, null);
  const future = testTimeBudget([receipt('submit', 1, 10, { at: new Date(NOW + 1).toISOString() })], NOW);
  assert.equal(future.submit.unknown, 1);
  const invalid = testTimeBudget([receipt('submit', 1, 10, { waitMs: -1, at: 'not-a-time' })], NOW);
  assert.equal(invalid.submit.unknown, 1);
  const slow = testTimeBudget(Array.from({ length: 50 }, (_, i) => receipt('submit', i, 480000)), NOW);
  assert.equal(slow.submit.sampleMeetsTargets, false, 'thresholds are strict, not inclusive');
});

test('nested inherited receipts and shard-only runs never become full gate samples [C7]', () => {
  const replay = rows();
  replay.push(receipt('landing', 52, 4, { inherited: true }));
  replay.push(receipt('submit', 52, 4, { slot: { kind: 'inherited' } }));
  replay.push(receipt('submit', 53, 4, { inherited: true }));
  const report = testTimeBudget(replay, NOW);
  assert.deepEqual(report, testTimeBudget(rows(), NOW));
  const shards = testTimeBudget([receipt('landing', 1, 4, { timingOperation: 'landing-shard' })], NOW);
  assert.equal(shards.landingGate.receipts, 0);
  assert.equal(shards.landingGate.p50Ms, null);
});

test('canonical phase replay partitions the whole operation without adding worker times twice [C7]', () => {
  const phases = phasesOf({ requestedAt: 0, queuedAt: 100, admittedAt: 200, actionAt: 300, runAt: 400, ranAt: 500 }, 1000);
  assert.deepEqual(phases, { waitMs: 100, admissionMs: 200, setupMs: 100, runMs: 100, evidenceMs: 500 });
  const report = testTimeBudget([{ ...receipt('submit', 1, 1000), ...phases,
    executionPhases: { commandMs: 1000000 }, wallMs: 1000000 }], NOW);
  assert.equal(report.submit.p50Ms, 1000, 'child phases and repeated profile copies are not additive');
});

test('stats replays private receipt storage in JSON and text with uncertainty intact [C7]', { timeout: 30000 }, t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node --test');
  const file = receiptLog(box.repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows().map(row => JSON.stringify({ ...row, at: '2026-01-01T00:00:00Z' })).join('\n') + '\n');
  const before = readFileSync(file, 'utf8');
  // budget: timeout above is only a hang ceiling for the real CLI fixture.
  const json = box.run(box.repo, 'stats', '--json');
  assert.equal(json.code, 0, json.err);
  const document = JSON.parse(json.out);
  assert.equal(document.testWallBudgets.submit.receipts, 50);
  assert.equal(document.testWallBudgets.submit.p50Ms, 26000);
  assert.equal(document.testWallBudgets.dayOfRealLandings, 'not-asserted');
  const text = box.run(box.repo, 'stats');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /test wall budgets, last 50 receipts each \(waits included\)/);
  assert.match(text.out, /landing-gate: 50\/50 receipts/);
  assert.equal(readFileSync(file, 'utf8'), before, 'measurement does not rewrite receipt history');
});
