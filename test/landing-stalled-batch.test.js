/** A stalled landing batch is recorded with its last step, preserves verified items, and lets the waiting queue continue [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLandingWorker } from '../packages/landing/index.js';
import { landingProgressSnapshot, landingProgressed, landingStallDescription, landingStallExpired } from '../packages/landing/src/shell/landing-progress.js';
import { parseProcessCensus } from '../packages/kernel/src/core/process-census.js';
import { LANDING_NEXT_BATCH_MS, landingRetryAt } from '../apps/cli/src/shell/commands/land.js';

const NOW = 1_000_000;
const BATCH = { id: 'batch-1', revision: 7, state: 'gating', logPath: '/tmp/batch-1/logs/batch-4.log' };

/** Run the real parent monitor against a tiny guardian that records a batch and then stops advancing. */
async function runStalledGuardian(t, { progressLog = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-landing-stall-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'gate.log');
  const workerFile = join(dir, 'guardian.cjs');
  const source = `const { appendFileSync } = require('node:fs');
process.on('message', message => {
  if (message.type !== 'start') return;
  process.send({ type: 'call', id: 1, operation: 'recordLandingBatch', args: [{ agentId: 'coordinator', batch: { id: 'batch-1', revision: 7, state: 'gating', logPath: ${JSON.stringify(logPath)} } }] });
  ${progressLog ? `const timer = setInterval(() => appendFileSync(${JSON.stringify(logPath)}, 'x'), 5); setTimeout(() => { clearInterval(timer); process.send({ type: 'result', value: { landed: [] } }, () => process.disconnect()); }, 100);` : 'setInterval(() => {}, 1000);'}
});\n`;
  writeFileSync(workerFile, source);
  let stalled;
  const result = await runLandingWorker({ root: dir }, { write: async (_operation, args) => args[0].batch,
    checkLease: async () => {}, checkLeaseNow: () => {}, bindWorker: async () => {}, watchDeadline: () => () => {}, say: () => {},
    signal: new AbortController().signal, workerFile, parseProcessCensus, stallAfterMs: 45, stallPollMs: 5,
    onStall: async evidence => { stalled = evidence; return { batch: { ...evidence.batch, state: 'blocked', refusal: { code: 'LAND_STALLED', message: evidence.description } }, landed: [], stalled: true }; } });
  return { result, stalled };
}

test('a landing with no progress for ten minutes names the recorded state and step [B3,R3,C7]', () => {
  assert.equal(landingStallExpired(NOW, NOW + 599_999), false);
  assert.equal(landingStallExpired(NOW, NOW + 600_000), true);
  assert.equal(landingStallDescription(BATCH, 'gating/batch-4.log'), 'batch batch-1 made no progress for 10 minutes in state gating; last step gating/batch-4.log');
});

test('a revision advance, new runner job, or new log bytes resets the landing stall clock [B3,R3,C7]', () => {
  const previous = landingProgressSnapshot(BATCH, { logBytes: 10, runnerJobs: ['pid-1:start-a'] });
  assert.equal(landingProgressed(previous, landingProgressSnapshot({ ...BATCH, revision: 8 }, { logBytes: 10, runnerJobs: ['pid-1:start-a'] })), true);
  assert.equal(landingProgressed(previous, landingProgressSnapshot(BATCH, { logBytes: 11, runnerJobs: ['pid-1:start-a'] })), true);
  assert.equal(landingProgressed(previous, landingProgressSnapshot(BATCH, { logBytes: 10, runnerJobs: ['pid-1:start-a', 'pid-2:start-b'] })), true);
  assert.equal(landingProgressed(previous, landingProgressSnapshot(BATCH, { logBytes: 10, runnerJobs: ['pid-1:start-a'] })), false);
});

test('clause 1: a timed out batch is blocked with its recorded state and step [B3,R3,C7]', async t => {
  const { result, stalled } = await runStalledGuardian(t);
  assert.equal(stalled.batch.state, 'gating');
  assert.match(stalled.description, /state gating; last step gating\/gate\.log/u);
  assert.equal(result.batch.state, 'blocked');
  assert.equal(result.batch.refusal.code, 'LAND_STALLED');
  assert.equal(result.stalled, true);
});

test('clause 2: a stalled batch preserves verified items and schedules the waiting queue [B3,R3,C7]', async t => {
  const { result } = await runStalledGuardian(t);
  assert.deepEqual(result.landed, [], 'the stall does not land or rewrite any verified item');
  assert.equal(result.batch.state, 'blocked');
  assert.deepEqual(landingRetryAt({ ...result, waiting: true }, NOW), new Date(NOW + LANDING_NEXT_BATCH_MS).toISOString());
});

test('clause 3: new gate log bytes keep a landing alive past its inactivity limit [B3,R3,C7]', async t => {
  const { result, stalled } = await runStalledGuardian(t, { progressLog: true });
  assert.equal(stalled, undefined);
  assert.deepEqual(result, { landed: [] });
});

test('CPU time spent by the worker\'s descendants counts as progress, so a long local scan is not a stall [B3,R3]', () => {
  const batch = { id: 'b', revision: 3, state: 'gating', logPath: '/nowhere/log' };
  const before = landingProgressSnapshot(batch, { logBytes: 0, runnerJobs: [], cpuMs: 1000 });
  const busy = landingProgressSnapshot(batch, { logBytes: 0, runnerJobs: [], cpuMs: 4000 });
  const idle = landingProgressSnapshot(batch, { logBytes: 0, runnerJobs: [], cpuMs: 4000 });
  assert.equal(landingProgressed(before, busy), true, 'more descendant CPU time is progress');
  assert.equal(landingProgressed(busy, idle), false, 'no new bytes, jobs or CPU time is not');
  assert.equal(landingProgressed(landingProgressSnapshot(batch, { logBytes: 5 }), landingProgressSnapshot(batch, { logBytes: 5 })), false, 'snapshots without cpuMs compare as before');
});
