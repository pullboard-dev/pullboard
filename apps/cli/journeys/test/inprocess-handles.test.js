/** In-process CLI runs end cleanly: commands run in this process leave no timer, socket, child or other handle open [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const DIRS = [];
after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

/** The resources keeping this process's event loop alive, counted by kind. */
function liveResources() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/**
 * Each kind with more live resources now than before.
 * Why: a resource that outlives the commands would keep a CLI process from exiting by itself; measuring it in this
 * process answers the same question as a child that must exit, with no node start-up.
 */
function added(before, now) {
  return Object.fromEntries(Object.entries(now).filter(([kind, count]) => count > (before[kind] ?? 0)));
}

test('init and a board command run in-process leave no live resource behind [C7]', async t => {
  const dir = privateFixtureFiles('pullboard-inproc-handles-').root;
  DIRS.push(dir);
  const repo = temporaryRepository(t, 'pullboard-inproc-handles-repo-');
  const env = { ...process.env, PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Handles', GIT_AUTHOR_EMAIL: 'h@example.invalid',
    GIT_COMMITTER_NAME: 'Handles', GIT_COMMITTER_EMAIL: 'h@example.invalid', PULLBOARD_VIEW_BACKGROUND: '0' };
  await tick();
  const before = liveResources();
  const init = await runCliInProcess(['init'], { cwd: repo, env });
  const list = await runCliInProcess(['list', '--json'], { cwd: repo, env });
  await tick();
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.deepEqual(added(before, liveResources()), {}, 'no timer, socket, child or other handle outlives the commands');
});
