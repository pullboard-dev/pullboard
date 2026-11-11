/** Three linked replicas recover lost replies once and agree on the final order [H3,H16,V1,V17]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { readAcceptedCells } from '../../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { withFileLock } from '../../../../../packages/outbox/index.js';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import {
  after,
  test,
} from 'node:test';
import { threeReplicaPhaseCapture } from '../../../tests/fixtures/relay/client/timing.js';
import {
  finalReplicaOrder,
  recoverReplicaReplies,
  threeReplicaFixture,
} from '../../../tests/fixtures/relay/client-harness.js';

after(cleanupFixtureChildren);

/**
 * Publish each replica's accepted main inventory in its own machine home, as the background producer does on a real
 * board (#3533). Why: native submit refuses CELLS_INVENTORY_PENDING until main has one, and a fixture has no producer.
 */
async function publishAcceptedInventories(fixture) {
  const stash = join(fixture.scratch, 'inventory-stash');
  let stashedTree = '';
  /** Run work with the process machine home set to one replica's, as that replica's CLI sees it. */
  const inMachineHome = async (env, work) => {
    const previous = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    try { return await work(); } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
  };
  /** Analyze the first replica's current main once and keep the published inventory in the stash. */
  const publishFirst = async (tree) => {
    const main = String(fixture.gitAt(fixture.clones[0], fixture.envs[0], 'rev-parse', 'main')).trim();
    const artifact = await inMachineHome(fixture.envs[0], () => warmAcceptedCells(fixture.clones[0], main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: 'main' }));
    assert.equal(artifact.available, true, 'the producer published the replica main inventory');
    rmSync(stash, { recursive: true, force: true });
    cpSync(join(fixture.envs[0].PULLBOARD_MACHINE_HOME, 'cells-cache'), stash, { recursive: true });
    stashedTree = tree;
  };
  const mainTree = () => String(fixture.gitAt(fixture.clones[0], fixture.envs[0], 'rev-parse', 'main^{tree}')).trim();
  for (let index = 0; index < fixture.clones.length; index += 1) fixture.envs[index].PULLBOARD_MACHINE_HOME = join(fixture.envs[index].HOME, 'machine');
  await publishFirst(mainTree());
  /**
   * Put the published inventory back in every replica's machine home; a CLI step can drop it before a later submit, and
   * relay moves can advance main to a tree it was not published for, so a changed main is analyzed again (once, then copied).
   */
  const restore = async () => {
    const tree = mainTree();
    if (tree !== stashedTree) await publishFirst(tree);
    for (const env of fixture.envs) cpSync(stash, join(env.PULLBOARD_MACHINE_HOME, 'cells-cache'), { recursive: true, force: true });
  };
  await restore();
  for (let index = 0; index < fixture.clones.length; index += 1) {
    const main = String(fixture.gitAt(fixture.clones[index], fixture.envs[index], 'rev-parse', 'main')).trim();
    assert.equal(await inMachineHome(fixture.envs[index], () => readAcceptedCells(fixture.worktrees[index], main).available), true, 'a submit from the seat worktree reads it');
  }
  return restore;
}

test('clause 1 and clause 2: [H3,H16,V1,V17] three cloned linked replicas recover lost replies once', { timeout: 200_000 }, async (t) => { // 45 recovery/final-order CLI spawns at the captured ~4s per recovery wait, plus 20s for fixture setup; excludes the preceding 170s claims.
  const timing = threeReplicaPhaseCapture(t);
  return timing.run(async () => {
    const fixture = await threeReplicaFixture(t, timing);
    const restoreInventories = await publishAcceptedInventories(fixture);
    await recoverReplicaReplies(fixture, timing, restoreInventories);
    await finalReplicaOrder(fixture, timing);
    timing.finish(['cloning three replicas', 'lost-reply recovery', 'final order check']);
  });
});

