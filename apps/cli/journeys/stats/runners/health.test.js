/** Runner run time and health from seeded claims, receipts, retries and lost jobs, with exact counts [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  createJob,
  writeStep,
} from '../../../../../packages/jobs/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureOpenBoard } from '../../../tests/fixtures/testkit.js';

/** Epoch ms of a time on the seeded day. */
const at = (time) => Date.parse(`2026-10-12T${time}Z`);

/** Seed the known jobs, steps and events. */
function seed(db) {
  /** A pull job with its attempts: each is [runner, claimed time, receipt time or null]. */
  const pull = (id, kind, attempts) => {
    createJob(db, { id, kind, now: at(attempts[0][1]) });
    attempts.forEach(([runner, claimed, receipt], index) => {
      writeStep(db, id, 'claimed', { runner }, { seq: index + 1, now: at(claimed) });
      if (receipt) writeStep(db, id, 'receipt', { runner, attempt: index + 1 }, { seq: index + 1, now: at(receipt) });
    });
  };
  pull('p', 'gate-shard', [['runner-a', '10:00:00.000', '10:01:00.000']]);
  pull('q', 'gate-shard', [['runner-a', '10:05:00.000', '10:05:30.000']]);
  pull('r', 'gate-shard', [['runner-b', '10:10:00.000', '10:12:00.000']]);
  pull('s', 'gate', [['runner-a', '10:20:00.000', null], ['runner-b', '10:25:00.000', '10:35:00.000']]);
  pull('t', 'gate', [['runner-b', '11:00:00.000', '11:00:40.000']]);
  pull('w', 'gate-shard', [['runner-a', '11:00:10.000', '11:00:20.000']]);
  createJob(db, { id: 'u', kind: 'test-run', now: at('10:30:00.000') });
  writeStep(db, 'u', 'queued', {}, { now: at('10:30:00.000') });
  writeStep(db, 'u', 'running', { pid: 1 }, { now: at('10:30:00.000') });
  writeStep(db, 'u', 'result', { green: true, runner: 'runner-a' }, { now: at('10:30:50.000') });
  createJob(db, { id: 'v', kind: 'test-run', now: at('11:30:00.000') });
  writeStep(db, 'v', 'queued', {}, { now: at('11:30:00.000') });
  writeStep(db, 'v', 'running', { pid: 2 }, { now: at('11:30:00.000') });
  writeStep(db, 'v', 'lost', { pid: 2, lapsedMs: 120000 }, { now: at('11:35:00.000') });
}


/** A project whose board holds the seeded rows; the board is closed again before the CLI reads it. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite'), web: box.repo });
  try { seed(board.db); } finally { store.closeBoard(board); }
  return box;
}

/** Run one real CLI invocation in the project and return its code and output. */
function command(box, args) {
  return box.runLocal(box.web, ...args);
}

test('runners health: seeded jobs give exact run time per runner and kind, and exact health counts [C7]', async t => {
  const box = fixture(t);
  const result = await command(box, ['stats', 'runners', '--health', '--window', '2h', '--until', '2026-10-12T12:00:00Z', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const { health } = JSON.parse(result.stdout).runners;
  assert.deepEqual(health.runtimes, [
    { runner: 'runner-a', kind: 'gate-shard', count: 3, p50Ms: 30000, p90Ms: 60000 },
    { runner: 'runner-a', kind: 'test-run', count: 1, p50Ms: 50000, p90Ms: 50000 },
    { runner: 'runner-b', kind: 'gate', count: 2, p50Ms: 40000, p90Ms: 600000 },
    { runner: 'runner-b', kind: 'gate-shard', count: 1, p50Ms: 120000, p90Ms: 120000 },
  ]);
  assert.deepEqual(health.runners, [
    { runner: 'local', runs: 0, retries: 0, replaced: 0, lost: 1, upSpans: [{ from: '2026-10-12T11:30:00.000Z', to: '2026-10-12T11:30:00.000Z' }], downMs: 0 },
    { runner: 'runner-a', runs: 4, retries: 0, replaced: 0, lost: 1,
      upSpans: [{ from: '2026-10-12T10:00:00.000Z', to: '2026-10-12T10:30:50.000Z' }, { from: '2026-10-12T11:00:10.000Z', to: '2026-10-12T11:00:20.000Z' }], downMs: 1760000 },
    { runner: 'runner-b', runs: 3, retries: 1, replaced: 1, lost: 0,
      upSpans: [{ from: '2026-10-12T10:10:00.000Z', to: '2026-10-12T10:35:00.000Z' }, { from: '2026-10-12T11:00:00.000Z', to: '2026-10-12T11:00:40.000Z' }], downMs: 1500000 },
  ]);
});

test('runners health text prints each runner and a plain stats runners explains the flag [C7]', async t => {
  const box = fixture(t);
  const text = await command(box, ['stats', 'runners', '--health', '--window', '2h', '--until', '2026-10-12T12:00:00Z']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /runner-b: 3 runs, 0 lost leases, 1 retries, 1 re-placed, 2 up spans, down 1500\.0s/u);
  const plain = await command(box, ['stats', 'runners', '--json']);
  assert.equal(plain.code, 1);
  assert.equal(JSON.parse(plain.stdout).error.code, 'USAGE');
});
