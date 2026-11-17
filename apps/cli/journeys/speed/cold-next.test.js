/** A cold next answers a seat that holds its item without idling on its own async work, and starts at most 3 git processes [C7,#8574]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  after,
  test,
} from 'node:test';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { startNextProgressMonitor } from '../../src/io/next/monitor.js';
import { coldNext } from '../../tests/fixtures/cold-next.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** A seat that claimed one item, so the measured next is the repeated call a builder makes, answered by a cold worker. */
async function heldCold() {
  const box = helpers.project('true');
  const id = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Cold next build', args: ['--specs', 'G1'], run: box.runLocal })).item_id;
  box.git(box.repo, 'config', 'pullboard.trunk', 'main'); // A real board records its trunk, so reading it starts no git.
  const claimed = await box.runIn(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const cold = await coldNext(box.web, box.env);
  assert.equal(cold.status, 0, cold.err + cold.out);
  assert.match(cold.out, new RegExp(`you hold #${id}\\b`, 'u'), 'the cold next answers the held item');
  return cold;
}

test('clause 1: a cold pullboard next spends under 100 ms idle in the event loop [C7,#8574]', { timeout: 120_000 }, async t => {
  const cold = await heldCold();
  t.diagnostic(`cold next idle ${cold.idleMs.toFixed(1)} ms`);
  assert.ok(cold.idleMs < 100, `a cold next idles ${cold.idleMs.toFixed(1)} ms`);
  // The progress worker starts with the real stderr only; next proceeds without awaiting its readiness or its exit.
  const before = performance.eventLoopUtilization();
  const monitor = startNextProgressMonitor({ stderr: process.stderr });
  assert.equal(typeof monitor?.then, 'undefined', 'starting the progress worker returns at once, not a promise to await');
  monitor?.enter('context', null);
  await monitor?.close();
  await yieldLoop();
  const idle = performance.eventLoopUtilization(before).idle;
  assert.ok(idle < 100, `starting and closing the progress worker idles ${idle.toFixed(1)} ms`);
});

test('clause 2: a cold pullboard next starts at most 3 git processes [C7,#8574]', { timeout: 120_000 }, async t => {
  const cold = await heldCold();
  t.diagnostic(`cold next git processes (${cold.git.length}): ${cold.git.join(' | ')}`);
  assert.ok(cold.git.length <= 3, `a cold next starts ${cold.git.length} git processes: ${cold.git.join(' | ')}`);
});
