/** A retained test run lives under the repository's common Git folder, so it outlives the worktree that made it [C7,#10845]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { retainTestOutput } from '../../../heavy.js';
import { boardFolderFile } from '../../../../git/index.js';

const LOG = 'TAP version 13\nok 1 - holds\n1..1\n# pass 1\n# fail 0\n';

/** A repository with one commit and a linked worktree beside it. */
function repo(t) {
  const { root: main } = privateFixtureFiles('gate-summary-runs-');
  const { root: beside } = privateFixtureFiles('gate-summary-linked-');
  const linked = join(beside, 'linked');
  t.after(() => { rmSync(main, { recursive: true, force: true }); rmSync(beside, { recursive: true, force: true }); });
  const sh = (cwd, ...args) => runFixtureGit(args, { cwd });
  sh(main, 'init', '-q', '-b', 'main');
  sh(main, 'config', 'user.email', 't@example.com');
  sh(main, 'config', 'user.name', 't');
  sh(main, 'commit', '-q', '--allow-empty', '-m', 'start');
  sh(main, 'worktree', 'add', '-q', '--detach', linked);
  return { main: realpathSync(main), linked: realpathSync(linked), sh };
}

test('gate.summary.run-in-common-dir: clause 1: a run started in a linked worktree writes its folder under the common git folder, not the worktree git folder [C7,#10845]', (t) => {
  const { main, linked, sh } = repo(t);
  const common = realpathSync(join(main, '.git'));
  const worktreeGit = realpathSync(sh(linked, 'rev-parse', '--absolute-git-dir'));
  assert.notEqual(worktreeGit, common, 'the fixture worktree has its own git folder');
  const summary = retainTestOutput(linked, LOG);
  const runs = join(common, 'pullboard', 'pullboard-runs');
  assert.equal(dirname(dirname(summary.logPath)), runs, 'the run folder sits in the common git folder keyed by run id');
  assert.ok(!summary.logPath.startsWith(worktreeGit + '/'), 'nothing is written under the worktree git folder');
  assert.equal(readFileSync(summary.logPath, 'utf8'), LOG);
});

test('gate.summary.run-survives-worktree-removal: clause 2: after git worktree remove of the folder that made the run, its output.log and summary are still read by run id from the main checkout [C7,#10845]', (t) => {
  const { main, linked, sh } = repo(t);
  const summary = retainTestOutput(linked, LOG);
  const id = basename(dirname(summary.logPath));
  sh(main, 'worktree', 'remove', '--force', linked);
  assert.ok(!existsSync(linked), 'the worktree is gone');
  const found = join(boardFolderFile(main, join('pullboard-runs', id)), 'output.log');
  assert.equal(found, summary.logPath, 'the main checkout resolves the same run folder by id');
  assert.equal(readFileSync(found, 'utf8'), LOG);
  const again = retainTestOutput(main, readFileSync(found, 'utf8'), { directory: dirname(dirname(found)) });
  assert.deepEqual(again.counts, summary.counts, 'the summary reads the same counts after removal');
});
