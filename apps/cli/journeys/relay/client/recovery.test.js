/** Three linked replicas recover lost replies once and agree on the final order [H3,H16,V1,V17]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
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
  /** Put the published inventory back in every replica's machine home; a CLI step can drop it before a later submit. */
  const restore = () => {
    for (const env of fixture.envs) cpSync(stash, join(env.PULLBOARD_MACHINE_HOME, 'cells-cache'), { recursive: true, force: true });
  };
  for (let index = 0; index < fixture.clones.length; index += 1) {
    const env = fixture.envs[index];
    env.PULLBOARD_MACHINE_HOME = join(env.HOME, 'machine');
    const previous = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    try {
      const main = String(fixture.gitAt(fixture.clones[index], env, 'rev-parse', 'main')).trim();
      // The three clones share one main tree, so the first replica's analysis is the others' too: copy its published
      // inventory instead of re-analyzing the tree twice more (about 35 s each on a loaded runner).
      if (index > 0) cpSync(join(fixture.envs[0].PULLBOARD_MACHINE_HOME, 'cells-cache'), join(env.PULLBOARD_MACHINE_HOME, 'cells-cache'), { recursive: true });
      else {
        const artifact = await warmAcceptedCells(fixture.clones[index], main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: 'main' });
        assert.equal(artifact.available, true, 'the producer published the replica main inventory');
        cpSync(join(env.PULLBOARD_MACHINE_HOME, 'cells-cache'), stash, { recursive: true });
      }
      assert.equal(readAcceptedCells(fixture.worktrees[index], main).available, true, 'a submit from the seat worktree reads it');
    } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
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

