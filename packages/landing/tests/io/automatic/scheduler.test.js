/** The automatic lander always runs the main checkout's code, never a seat's worktree copy [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { mainLandingWorker } from '../../../src/io/automatic/scheduler.js';

/** A repository with a linked worktree; `lander` says whether main carries apps/cli/src/io/landing/automatic.js. */
function repo(t, { lander }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-main-worker-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main');
  mkdirSync(join(main, 'apps/cli/src/io/landing'), { recursive: true });
  if (lander) writeFileSync(join(main, 'apps/cli/src/io/landing/automatic.js'), '');
  else writeFileSync(join(main, 'README'), '');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  const seat = join(root, 'seat');
  git(main, 'worktree', 'add', '-q', '--detach', seat, 'main');
  return { main, seat };
}

test('a seat worktree wakes the main checkout lander, never its own copy [C7]', t => {
  const { main, seat } = repo(t, { lander: true });
  const own = pathToFileURL(join(seat, 'apps/cli/src/io/landing/automatic.js'));
  assert.equal(mainLandingWorker(seat, own).href, pathToFileURL(join(main, 'apps/cli/src/io/landing/automatic.js')).href);
});

test('a project with no lander in its main checkout keeps the installed CLI entry [C7]', t => {
  const { seat } = repo(t, { lander: false });
  const installed = pathToFileURL('/opt/pullboard/bin/automatic-landing.js');
  assert.equal(mainLandingWorker(seat, installed).href, installed.href);
});
