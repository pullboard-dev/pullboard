/** @pullboard-test-input source-cell packages/runners packages/config */
/** After one proof commit is scanned clean, its sibling's history scan reads only base..commit, not from the root [C7,#5550]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from '../../../../config/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { protectHistory } from '../../../index.js';

const HISTORY = 100;
const AUTHOR = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];

/** A repository of 100 single-file commits, with an own machine home so no other run's verdicts are reused. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-scan-incr-');
  const home = privateFixtureFiles('pullboard-scan-incr-home-');
  const root = files.root;
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home.root;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(root, { recursive: true, force: true });
    rmSync(home.root, { recursive: true, force: true });
  });
  const git = (...args) => runFixtureGit(args, { cwd: root, encoding: 'utf8' });
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  const addPath = (path, body) => {
    files.write(path, body);
    git('add', path);
    git(...AUTHOR, 'commit', '-q', '-m', path);
    return git('rev-parse', 'HEAD');
  };
  const add = n => addPath(`src/file-${n}.txt`, `${n}\n`);
  const commits = Array.from({ length: HISTORY }, (_, index) => add(index));
  /** Make any history walk that reaches this commit fail, by dropping its tree object. */
  const poison = commit => {
    const tree = git('rev-parse', `${commit}^{tree}`);
    rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  };
  return { root, commits, add, addPath, poison };
}

test('clause 1: after one proof commit is scanned clean, a sibling scans only base..commit, not from the root [C7,#5550]', t => {
  const policies = [defaults().protect];
  const { root, commits, add, poison } = fixture(t);
  const tip = commits[HISTORY - 1];
  // Two proof commits on one main tip: siblings, neither an ancestor of the other.
  const git = (...args) => runFixtureGit(args, { cwd: root, encoding: 'utf8' });
  const first = add(HISTORY);
  git('checkout', '-q', '--detach', tip);
  const sibling = add(HISTORY + 1);
  assert.notEqual(first, sibling);
  protectHistory(root, { commit: first }, policies);
  poison(commits[0]);
  poison(commits[HISTORY / 2]);
  // The first scan kept the tip as clean, so the sibling reads only tip..sibling; a walk from the root meets the dropped objects.
  assert.doesNotThrow(() => protectHistory(root, { commit: sibling }, policies), 'the sibling reads only the commits after the shared tip');
  assert.throws(() => protectHistory(root, { commit: sibling }, [{ ...defaults().protect, cold: true }]), { code: 'RUNNER_SOURCE' }, 'a scan from the root meets the dropped commits');
});
