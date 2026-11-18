/** A GUI proof plans shards only onto runners known to have a GUI session, so none waits on a runner that cannot take it [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { freeRunnerSlots } from '../../../../src/io/shards/proof.js';

const RUNNERS = [
  { host: 'gui-yes', slots: 3, browser: 2, gui: true },
  { host: 'gui-no', slots: 4, browser: 2, gui: false },
  { host: 'gui-unknown', slots: 4, browser: 2 },
];

/** Open a private machine pool holding one released gate lease, so the pool file exists; returns its path and a cleanup. */
async function pool() {
  const { root } = privateFixtureFiles('pullboard-gui-plan-');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  const { takeResource } = await import('../../../../../resources/index.js');
  const lease = await takeResource({ name: 'gate', scope: 'machine', root, repo: root, capacity: 0, browserCapacityProvider: () => 0, browser: true, gui: true,
    agent: 'core-1', item: '6783', kind: 'submit', runnerOnly: true, remote: true, runnerProvider: () => RUNNERS, onWait() { throw new Error('queued'); } });
  await lease.release();
  return { file: join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), done() {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  } };
}

test('gate.io-browser-admission-gui.a-gui-browser-plan-counts-only: clause 1: a GUI browser plan counts only runners observed with a GUI session, so no shard queues for a runner that cannot take it [C7]', async () => {
  const box = await pool();
  try { assert.equal(freeRunnerSlots(box.file, { browser: true, gui: true, runners: RUNNERS }), 2, 'only gui-yes counts'); } finally { box.done(); }
});

test('gate.io-browser-admission-gui.the-hold-reproduced-the-unobserved-four: clause 2: the hold reproduced: the unobserved four-slot runner is not planned for GUI work, and a plan with no GUI need still counts all three [C7]', async () => {
  const box = await pool();
  try {
    assert.equal(freeRunnerSlots(box.file, { browser: true, gui: true, runners: [RUNNERS[2]] }), 0, 'an unobserved runner alone offers no GUI slot');
    assert.equal(freeRunnerSlots(box.file, { browser: true, gui: false, runners: RUNNERS }), 6, 'without a GUI need every browser runner counts');
  } finally { box.done(); }
});
