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
  assert.deepEqual(landingControllerPlacement(project(t, 6)), { remote: false });
});

test('an unsharded landing may still run whole on a runner [C7,#3158]', t => {
  assert.deepEqual(landingControllerPlacement(project(t, 1)), {});
  assert.deepEqual(landingControllerPlacement(project(t)), {});
});

test('a required executor or runners-only policy keeps the controller placement unchanged [C7,#3158]', t => {
  assert.deepEqual(landingControllerPlacement(project(t, 6), { required: { kind: 'ssh', host: 'runner' } }), {});
  assert.deepEqual(landingControllerPlacement(project(t, 6), { runnerOnly: true }), {});
});

test('only the two gate controllers ask for local placement; shard acquisition never does [C7,#3158]', async () => {
  const { readFileSync } = await import('node:fs');
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.match(read('packages/landing/src/core/land-local-guard.js'), /landingControllerPlacement\(root/u);
  assert.match(read('packages/gate/src/shell/gate-execution.js'), /landing \? landingControllerPlacement\(root/u);
  assert.doesNotMatch(read('packages/landing/src/shell/landing-shards.js'), /landingControllerPlacement/u, 'shards keep runner placement');
  const slot = /export async function withLandingGateSlot[\s\S]*?\n\}/u.exec(read('packages/gate/src/shell/gate-execution.js'))[0];
  assert.doesNotMatch(slot, /landingControllerPlacement/u, 'the shared slot helper used by shards stays unchanged');
});
