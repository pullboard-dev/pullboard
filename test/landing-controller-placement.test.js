/** @pullboard-test-input source-tree */
/** A sharded landing gate runs its controller on the coordinator, so its shards fan out to the runners [C7,#3158]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingControllerPlacement } from '../packages/gate/src/shell/gate-execution.js';

/** A project root whose pullboard.json sets landingShards. */
function project(t, shards) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-placement-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(shards === undefined ? {} : { landingShards: shards }));
  return root;
}

test('a landing with landingShards above 1 keeps its controller local so it can shard [C7,#3158]', t => {
  const placement = landingControllerPlacement(project(t, 6));
  assert.deepEqual(placement, { remote: false, runnerOnly: false, runnerWaitMs: undefined, runnerDeadlineAt: undefined });
  // Spread over a runners-only machine's admission, no runner-only deadline survives without runners-only.
  const options = { runnerOnly: true, remote: true, runnerWaitMs: 1_800_000, runnerDeadlineAt: Date.now() + 1000, ...placement };
  assert.equal(options.runnerOnly, false);
  assert.equal(options.runnerDeadlineAt, undefined);
  assert.equal(options.runnerWaitMs, undefined);
});

test('an unsharded landing may still run whole on a runner [C7,#3158]', t => {
  assert.deepEqual(landingControllerPlacement(project(t, 1)), {});
  assert.deepEqual(landingControllerPlacement(project(t)), {});
});

test('a required executor keeps its placement; a runners-only machine still keeps the controller local [C7,#3158]', async t => {
  assert.deepEqual(landingControllerPlacement(project(t, 6), { required: { kind: 'ssh', host: 'runner' } }), {});
  // The shards read runners-only themselves, so no shard runs on this machine even though the controller does.
  const { readFileSync } = await import('node:fs');
  const shards = readFileSync(new URL('../packages/landing/src/shell/landing-shards.js', import.meta.url), 'utf8');
  assert.match(shards, /runnerAdmission = gateRunnerAdmission\(\)/u, 'each shard takes its own runners-only admission');
});

test('only the two gate controllers ask for local placement; shard acquisition never does [C7,#3158]', async () => {
  const { readFileSync } = await import('node:fs');
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.match(read('packages/landing/src/core/land-local-guard.js'), /landingControllerPlacement\(root/u);
  assert.match(read('packages/gate/src/shell/gate-execution.js'), /landing && !runnerOnly \? landingControllerPlacement\(root/u);
  assert.doesNotMatch(read('packages/landing/src/shell/landing-shards.js'), /landingControllerPlacement/u, 'shards keep runner placement');
  const slot = /export async function withLandingGateSlot[\s\S]*?\n\}/u.exec(read('packages/gate/src/shell/gate-execution.js'))[0];
  assert.doesNotMatch(slot, /landingControllerPlacement/u, 'the shared slot helper used by shards stays unchanged');
});
