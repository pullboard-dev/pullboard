/** Direct seat tests share one slot and leave gate/verdict capacity available [C7,#2831]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeResource } from '../../../../index.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';

/** Isolate a real repository and resource SQLite database, including a second item worktree. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-seat-slot-'));
  const home = join(root, 'machine');
  mkdirSync(home);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Slot fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Slot fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  runFixtureGit(['commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo, env });
  const item = join(root, 'item');
  runFixtureGit(['worktree', 'add', '-q', '--detach', item], { cwd: repo, env });
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { repo, item };
}

/** Observe an actual queued refusal without leaving a waiter or sleeping on a resource. */
async function blocked(options) {
  const stop = new Error('observed queued seat test');
  let waited = false;
  await assert.rejects(takeResource({ ...options, onWait: () => { waited = true; throw stop; } }), error => error === stop);
  assert.equal(waited, true);
}

for (const remote of [false, true]) {
  test(`one seat test slot spans item worktrees and preserves gate capacity on ${remote ? 'a runner' : 'the local machine'} [C7,#2831]`, async t => {
    const box = fixture(t);
    const base = { name: 'gate', scope: 'machine', root: box.repo, capacity: remote ? 0 : 4,
      ...(remote ? { remote: true, runnerOnly: true, runnerProvider: () => [{ host: 'fixture-runner', slots: 4, browser: 0 }] } : {}) };
    const held = [];
    try {
      held.push(await takeResource({ ...base, agent: 'seat-a', kind: 'seat-test' }));
      await blocked({ ...base, root: box.item, agent: 'seat-a', kind: 'test' });
      // Distinct seats may make progress while a duplicate request from the first remains queued.
      held.push(await takeResource({ ...base, agent: 'seat-b', kind: 'test' }));
      held.push(await takeResource({ ...base, agent: 'seat-c', kind: 'seat-test' }));
      await blocked({ ...base, agent: 'seat-d', kind: 'seat-test' });
      // Three test seats cannot consume the last slot: either a submit gate or a verdict can acquire it.
      for (const kind of ['gate', 'review']) {
        const gate = await takeResource({ ...base, agent: 'gate-seat', kind });
        assert.equal(Boolean(gate.runner), remote);
        gate.release();
      }
      held.shift().release();
      const resumed = await takeResource({ ...base, root: box.item, agent: 'seat-a', kind: 'seat-test' });
      resumed.release();
    } finally { for (const lease of held) lease.release(); }
  });
}

for (const remote of [false, true]) {
  test(`a seat test still runs on a single-slot ${remote ? 'runner' : 'machine'}: there is no spare slot to reserve [C7,#3169]`, async t => {
    const box = fixture(t);
    const base = { name: 'gate', scope: 'machine', root: box.repo, capacity: remote ? 0 : 1,
      ...(remote ? { remote: true, runnerOnly: true, runnerProvider: () => [{ host: 'fixture-runner', slots: 1, browser: 0 }] } : {}) };
    const lease = await takeResource({ ...base, agent: 'seat-a', kind: 'seat-test', onWait: () => { throw new Error('a seat test waited on an idle single-slot executor'); } });
    try { assert.equal(Boolean(lease.runner), remote); } finally { lease.release(); }
  });
}
