/** @pullboard-test-input source-cell packages/gate */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { warmAcceptedCells } from '../../src/io/inventory.js';
import { nudgeAcceptedCells } from '../../src/io/inventory.js';
import { privateFixtureFiles } from '../fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';
import { fixtureCommitAll } from '../fixtures/testkit.js';
import { fixtureCellsPlan } from '../fixtures/testkit.js';
import { fixtureCellsPlanPolicy } from '../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../fixtures/testkit.js';

/** Commit the old plan file alone, the new opt-in alone, or an empty opt-in. */
function inventoryProject(t, { legacy = false, plan } = {}) {
  const { root, write } = privateFixtureFiles('pullboard-inventory-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (legacy) fixtureCellsPlan(root, '{}');
  if (plan === undefined) fixtureProjectPolicy(root, {});
  else fixtureCellsPlanPolicy(root, plan);
  fixtureCommitAll(root);
  return { root, write, commit: runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }) };
}

test('gate.io-inventory.warm-keys-on-cells-plan: clause 1: accepted inventory warms only when the pinned policy names a plan [C7]', async t => {
  const legacy = inventoryProject(t, { legacy: true });
  const empty = inventoryProject(t, { plan: '  ' });
  const opted = inventoryProject(t, { plan: 'tools/custom-plan.json' });
  fixtureProjectPolicy(opted.root, {});
  const reachedCheckout = new Error('accepted checkout reached');
  const ports = { withCheckout: async () => { throw reachedCheckout; }, withLock: () => assert.fail('unexpected lock') };
  for (const { root, commit } of [legacy, empty]) {
    assert.deepEqual(await warmAcceptedCells(root, commit, ports), { available: false, cause: 'no-cells-plan' });
  }
  await assert.rejects(warmAcceptedCells(opted.root, opted.commit, ports), error => error === reachedCheckout);
});

test('gate.io-inventory.nudge-keys-on-cells-plan: clause 2: the pinned policy opt-in starts the inventory producer [C7]', async t => {
  const legacy = inventoryProject(t, { legacy: true });
  const opted = inventoryProject(t, { plan: 'tools/custom-plan.json' });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(opted.root, 'private-machine');
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = saved;
  });
  opted.write('worker.mjs', `process.exitCode = process.argv.slice(4).join(' ') === ${JSON.stringify('--cells-only ' + opted.commit)} ? 0 : 1;`);
  const worker = pathToFileURL(join(opted.root, 'worker.mjs'));
  assert.equal(await nudgeAcceptedCells(legacy.root, worker, legacy.commit), null);
  const child = await nudgeAcceptedCells(opted.root, worker, opted.commit);
  assert.ok(child?.pid, 'started an inventory producer for the configured commit');
  child.ref();
  assert.deepEqual(await once(child, 'exit'), [0, null]);
});
