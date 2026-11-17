/** @pullboard-test-input packages/landing/src/io/runner/job.js */
/** A land push into a checked-out trunk never leaves its working tree half-applied when main moves during the push [C7,#10404]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { pushTrunk } from '../../src/io/runner/job.js';

const TRUNK = 'refs/heads/main';
const IDENT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];

/** A non-bare trunk with main checked out and updateInstead set, plus a clone that builds one landing commit on its own file. */
function racingTrunk(t) {
  const { root: dir } = privateFixtureFiles('pullboard-push-race-');
  const trunk = cellRepo(t, { real: true }).root;
  runFixtureGit(['-C', trunk, 'config', 'receive.denyCurrentBranch', 'updateInstead']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  /** Clone the trunk at its current head and commit `file` on it, as one land job's composed tip. */
  const landing = (name, file) => {
    const clone = join(dir, name);
    runFixtureGit(['clone', '-q', trunk, clone]);
    writeFileSync(join(clone, file), `${name}\n`);
    runFixtureGit(['-C', clone, 'add', '.']);
    runFixtureSetupGit(['-C', clone, ...IDENT, 'commit', '-q', '-m', name]);
    return { clone, base: runFixtureGit(['-C', clone, 'rev-parse', 'HEAD~1']) };
  };
  const push = ({ clone, base }) => pushTrunk(clone, { payload: { checkout: true }, trunk: TRUNK, base, remote: trunk });
  const status = () => runFixtureGit(['-C', trunk, 'status', '--porcelain']);
  return { trunk, landing, push, status };
}

test('landing.push-race.a-losing-push-leaves-the-trunk-tree-clean: clause 1: a land push that loses to a commit landed on the same branch leaves the trunk checkout with no staged or unstaged changes against its HEAD [C7,#10404]', t => {
  const { trunk, landing, push, status } = racingTrunk(t);
  const first = landing('first', 'first.txt');
  const second = landing('second', 'second.txt');
  assert.equal(push(first).status, 0, 'the first landing moves main');
  const lost = push(second);
  assert.notEqual(lost.status, 0, 'the push built on the old main is refused');
  assert.equal(status(), '', 'the trunk checkout is untouched by the refused push');
  assert.equal(existsSync(join(trunk, 'first.txt')), true, 'the landed commit is in the work tree');
  assert.equal(existsSync(join(trunk, 'second.txt')), false, 'the refused commit left no file behind');
  assert.equal(runFixtureGit(['-C', trunk, 'rev-parse', 'HEAD']), runFixtureGit(['-C', first.clone, 'rev-parse', 'HEAD']));
});

test('landing.push-race.the-losing-job-lands-on-the-new-main: clause 2: the refused push lands once its job rebuilds on the new main, with the tree clean at each step [C7,#10404]', t => {
  const { trunk, landing, push, status } = racingTrunk(t);
  const first = landing('first', 'first.txt');
  const second = landing('second', 'second.txt');
  assert.equal(push(first).status, 0);
  assert.notEqual(push(second).status, 0);
  runFixtureGit(['-C', second.clone, 'pull', '-q', '--rebase', ...[], 'origin', 'main'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
  const retry = { clone: second.clone, base: runFixtureGit(['-C', second.clone, 'rev-parse', 'HEAD~1']) };
  assert.equal(push(retry).status, 0, 'the retry against the new main lands');
  assert.equal(status(), '');
  assert.equal(existsSync(join(trunk, 'first.txt')) && existsSync(join(trunk, 'second.txt')), true, 'both landings are in the work tree');
});
