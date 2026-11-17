/** @pullboard-test-input packages/landing/src/io/shards.js packages/landing/src/io/land/guard.js */
/** A sharded landing gate runs its controller on the coordinator, so its shards fan out to the runners [C7,#3158]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingControllerPlacement } from '../../../../src/io/execution.js';

/** A project root whose pullboard.json sets landingShards. */
function project(t, shards) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-placement-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify(shards === undefined ? {} : { landingShards: shards }));
  return root;
}

test('a landing with landingShards above 1 keeps its controller local so it can shard [C7,#3158]', t => {
  const placement = landingControllerPlacement(project(t, 6), { admission: {} });
  assert.deepEqual(placement, { remote: false, runnerOnly: false, runnerWaitMs: undefined, runnerDeadlineAt: undefined });
  // Spread over a runners-only machine's admission, no runner-only deadline survives without runners-only.
  const options = { runnerOnly: true, remote: true, runnerWaitMs: 1_800_000, runnerDeadlineAt: Date.now() + 1000, ...placement };
  assert.equal(options.runnerOnly, false);
  assert.equal(options.runnerDeadlineAt, undefined);
  assert.equal(options.runnerWaitMs, undefined);
});

test('an unsharded landing may still run whole on a runner [C7,#3158]', t => {
  assert.deepEqual(landingControllerPlacement(project(t, 1), { admission: {} }), {});
  assert.deepEqual(landingControllerPlacement(project(t), { admission: {} }), {});
});

test('a required executor keeps its placement; each shard reads runners-only itself [C7,#3158]', async t => {
  assert.deepEqual(landingControllerPlacement(project(t, 6), { required: { kind: 'ssh', host: 'runner' }, admission: {} }), {});
  // The shards read runners-only themselves, so no shard runs on this machine even though the controller does.
  const { readFileSync } = await import('node:fs');
  const shards = readFileSync(new URL('../../../../../landing/src/io/shards.js', import.meta.url), 'utf8');
  assert.match(shards, /runnerAdmission = gateRunnerAdmission\(\)/u, 'each shard takes its own runners-only admission');
});

test('only the two gate controllers ask for local placement; shard acquisition never does [C7,#3158]', async () => {
  const { readFileSync } = await import('node:fs');
  const read = file => readFileSync(new URL(`../../../../../../${file}`, import.meta.url), 'utf8');
  assert.match(read('packages/landing/src/io/land/guard.js'), /landingControllerPlacement\(root/u);
  assert.match(read('packages/gate/src/io/execution.js'), /landing && !runnerOnly \? landingControllerPlacement\(root/u);
  assert.doesNotMatch(read('packages/landing/src/io/shards.js'), /landingControllerPlacement/u, 'shards keep runner placement');
  const slot = /export async function withLandingGateSlot[\s\S]*?\n\}/u.exec(read('packages/gate/src/io/execution.js'))[0];
  assert.doesNotMatch(slot, /landingControllerPlacement/u, 'the shared slot helper used by shards stays unchanged');
});

test('on a runners-only coordinator a landing gate and its guards run on a runner, never as a local test process [C7,#3899]', t => {
  const admission = { runnerOnly: true, remote: true, runnerWaitMs: 1_800_000, runnerDeadlineAt: Date.now() + 1_800_000 };
  for (const shards of [6, 1, undefined]) {
    const placement = landingControllerPlacement(project(t, shards), { admission });
    assert.deepEqual(placement, admission, `landingShards ${shards}: the controller keeps the runner-only admission`);
    // runGate spreads the placement after the machine's admission; the run stays runner-only with its deadline.
    const options = { ...admission, runnerOnly: true, ...placement };
    assert.equal(options.runnerOnly, true);
    assert.equal(options.remote, true);
    assert.equal(options.runnerDeadlineAt, admission.runnerDeadlineAt);
  }
});
