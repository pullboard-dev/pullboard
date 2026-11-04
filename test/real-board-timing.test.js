/** Measure claim, release and next on a production SQLite board at the recorded board scale [H24]. */
import assert from 'node:assert/strict';
import { hostname, loadavg, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { openBoard } from '../apps/lib/index.js';
import * as store from '../packages/store/index.js';
import { createE2eHelpers } from './e2e-helpers.js';

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

test('claim, release and next each answer under 200 ms on a real SQLite board [H24]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const itemIds = [];
  for (let n = 0; n < 1000; n++) {
    itemIds.push(store.addItem(board, { by: 'coordinator', lane: 'web', title: `Timing item ${n}`,
      criterion: 'The local board move is measured on a real SQLite board.', specIds: ['G1'], check: 'true' }));
  }
  const samples = { claim: [], release: [], next: [] };
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
  await exercise(false);
  for (let round = 0; round < 3; round++) await exercise(true);
  const medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)]));
  t.diagnostic(JSON.stringify({ samplesMs: samples, mediansMs: medians, host: hostname(), load: loadavg(),
    node: process.version, cpus: cpus().length, items: store.listItems(board).length }));
  for (const [name, value] of Object.entries(medians)) {
    assert.ok(value < 200, `${name} median ${value.toFixed(2)} ms exceeds the 200 ms budget`);
  }
});
