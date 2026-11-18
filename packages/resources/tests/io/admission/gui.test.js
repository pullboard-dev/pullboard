/** A runner-only run that needs a GUI session while no registered runner has one is refused at once, never held [C7,#6875]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeResource } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

/** Isolate the machine resource SQLite database. */
function fixture(t) {
  const { root } = privateFixtureFiles('pullboard-no-gui-runner-');
  const home = join(root, 'machine');
  mkdirSync(home);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Runner-only gate options over a fixture pool, with a runner wait far longer than the test. */
function pool(root, runners, extra = {}) {
  return { name: 'gate', scope: 'machine', root, capacity: 0, remote: true, runnerOnly: true, gui: true, runnerWaitMs: 3_600_000, runnerProvider: () => runners, ...extra };
}

test('resources.gui.n6875-clause-2-a-gui-run: #6875 clause 2: a GUI run with no GUI runner is refused on its first poll, not held to the runner deadline [C7]', async t => {
  const root = fixture(t);
  await assert.rejects(
    takeResource({ ...pool(root, [{ host: 'mini-a', slots: 2, browser: 1 }, { host: 'mini-b', slots: 2, browser: 1 }]), agent: 'gui-run', onWait: async () => { throw new Error('the waiter queued instead of being refused'); } }),
    error => error.code === 'RUNNER_WAIT_DEADLINE' && /mini-a, mini-b/.test(error.message));
});

test('resources.gui.n6875-clause-1-a-gui-run: #6875 clause 1: a GUI run still waits in line when a GUI runner is registered but full [C7]', async t => {
  const root = fixture(t);
  const runners = [{ host: 'mini-a', slots: 1, browser: 1 }, { host: 'studio-host', slots: 1, browser: 1, gui: true }];
  const held = await takeResource({ ...pool(root, runners), gui: false, agent: 'holder', requiredExecutor: { kind: 'ssh', host: 'studio-host', hosts: ['studio-host'] } });
  const left = new Error('left');
  const waited = await takeResource({ ...pool(root, runners), agent: 'gui-run', onWait: async () => { throw left; } }).then(() => 'admitted', error => error);
  assert.equal(waited, left);
  await held.release?.();
});
