/** Measure claim, release and next on a production SQLite board at the recorded board scale [H24]. */
import assert from 'node:assert/strict';
import {
  hostname,
  loadavg,
  cpus,
} from 'node:os';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  readFileSync,
  watch,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  PULLBOARD_ENTRY,
  residentSocket,
} from '../../src/io/resident/client.js';

/** Run one production CLI command and retain its wall time and JSON result. */
function measured(box, cwd, ...args) {
  const started = performance.now();
  const result = box.run(cwd, ...args, '--json');
  const ms = performance.now() - started;
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return { ms, data: JSON.parse(result.out) };
}

/** Return the middle of three warm wall-clock samples. */
function median(values) {
  return [...values].sort((a, b) => a - b)[1];
}

/** Read the resident pid only after the daemon has written its listening marker. */
function residentPidAt(place) {
  try {
    const pid = Number(readFileSync(place.pid, 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

/** Await the observable pid-file event rather than polling or sleeping. */
function waitForResident(place) {
  const ready = residentPidAt(place);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(place.pid), (_event, filename) => {
      if (filename && filename.toString() === basename(place.pid)) {
        const pid = residentPidAt(place);
        if (pid) { watcher.close(); resolve(pid); }
      }
    });
    watcher.on('error', error => { watcher.close(); reject(error); });
    const afterWatch = residentPidAt(place);
    if (afterWatch) { watcher.close(); resolve(afterWatch); }
  });
}

test('clause 1: claim, release and next each answer under 500 ms through a warm resident on a real SQLite board [H24]', async t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  box.env.PULLBOARD_RESIDENT = '1';
  delete box.env.NODE_TEST_CONTEXT;
  delete box.env.PULLBOARD_TEST_RUNNER_PID;
  delete box.env.PULLBOARD_TRANSIENT;
  t.after(helpers.cleanup);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const itemIds = [];
  for (let n = 0; n < 1000; n++) {
    itemIds.push(store.addItem(board, { by: 'coordinator', lane: 'web', title: `Timing item ${n}`,
      criterion: 'The local board move is measured on a real SQLite board.', specIds: ['G1'], check: 'true' }));
  }
  let samples = { claim: [], release: [], next: [] };
  let residentPid = null;
  t.after(() => { if (residentPid) { try { process.kill(residentPid, 'SIGKILL'); } catch { /* The resident already exited. */ } } });
  const exercise = async record => {
    const next = measured(box, box.web, 'next', '--build');
    const id = next.data.item?.item_id ?? next.data.item_id;
    assert.ok(Number.isInteger(id), `next returned an item id: ${JSON.stringify(next.data)}`);
    if (record) samples.next.push(next.ms);
    const released = measured(box, box.web, 'release', String(id), '--reason', 'OTHER', '--note', 'Timing sample complete.', '--no-next');
    if (record) samples.release.push(released.ms);
    const claimId = itemIds.pop();
    const claimed = measured(box, box.web, 'claim', String(claimId));
    if (record) samples.claim.push(claimed.ms);
    measured(box, box.web, 'release', String(claimId), '--reason', 'OTHER', '--note', 'Timing sample complete.', '--no-next');
  };
  measured(box, box.repo, 'version'); // Starts the resident; wait until its pid is written only after it listens.
  const place = residentSocket(box.repo, PULLBOARD_ENTRY);
  residentPid = await waitForResident(place);
  await exercise(false);
  // The 500 ms budget is unchanged. A round that misses it while the host's one-minute load exceeds half its cores measured the
  // machine, not the commands, so it is measured again, at most twice more; a real slowdown misses every round [H24].
  let medians = {};
  for (let attempt = 1; attempt <= 3; attempt++) {
    samples = { claim: [], release: [], next: [] };
    for (let round = 0; round < 3; round++) await exercise(true);
    medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)]));
    t.diagnostic(JSON.stringify({ attempt, samplesMs: samples, mediansMs: medians, host: hostname(), load: loadavg(),
      node: process.version, cpus: cpus().length, items: store.listItems(board).length }));
    if (Object.values(medians).every(value => value < 500) || loadavg()[0] <= cpus().length / 2) break;
  }
  for (const [name, value] of Object.entries(medians)) {
    assert.ok(value < 500, `${name} median ${value.toFixed(2)} ms exceeds the 500 ms budget`);
  }
});
