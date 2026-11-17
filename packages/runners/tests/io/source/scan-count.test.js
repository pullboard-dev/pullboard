/** @pullboard-test-input source-cell packages/runners packages/config */
/** The history scan prints how many commits it walked, first and second, with and without a scanned ancestor [C7,#9859]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { defaults } from '../../../../config/index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { lastHistoryWalk } from '../../../index.js';
import { protectHistory } from '../../../index.js';

const HISTORY = 300;
const ADDED = 5;
const AUTHOR = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];

/** A repository of 300 single-file commits, with its own machine home so no other run's verdicts are reused. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-scan-count-');
  const home = privateFixtureFiles('pullboard-scan-count-home-');
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home.root;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(files.root, { recursive: true, force: true });
    rmSync(home.root, { recursive: true, force: true });
  });
  const git = (...args) => runFixtureGit(args, { cwd: files.root, encoding: 'utf8' });
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: files.root }).status, 0);
  const add = n => {
    files.write(`src/file-${n}.txt`, `${n}\n`);
    git('add', `src/file-${n}.txt`);
    git(...AUTHOR, 'commit', '-q', '-m', `file ${n}`);
    return git('rev-parse', 'HEAD');
  };
  const commits = Array.from({ length: HISTORY }, (_, index) => add(index));
  /** The commits one scan walked: the size of the revision range its history read covered. */
  const walked = () => {
    const { range } = lastHistoryWalk();
    return Number(git('rev-list', '--count', range));
  };
  return { root: files.root, commits, add, walked };
}

test('clause 1: the first and the second scan of a 300-commit history print the commits each walked, with a scanned ancestor and with none [C7,#9859]', t => {
  const { root, commits, add, walked } = fixture(t);
  const policies = [defaults().protect];
  protectHistory(root, { commit: commits[HISTORY - 1] }, policies);
  const first = walked();
  let child;
  for (let n = 0; n < ADDED; n++) child = add(HISTORY + n);
  protectHistory(root, { commit: child }, policies);
  const second = walked();
  // A policy set no scan has seen has no scanned ancestor, so the same child is walked in full.
  protectHistory(root, { commit: child }, [{ ...defaults().protect, cold: true }]);
  const cold = walked();
  console.log(`scan-count: first scan walked ${first} commits; second scan walked ${second} commits with a scanned ancestor; the same child with none walked ${cold} (history ${HISTORY}, ${ADDED} added)`);
  assert.equal(first, HISTORY);
  assert.equal(cold, HISTORY + ADDED);
});

test('clause 2: a scan with a scanned ancestor walks no more commits than were added since the first [C7,#9859]', t => {
  const { root, commits, add, walked } = fixture(t);
  const policies = [defaults().protect];
  protectHistory(root, { commit: commits[HISTORY - 1] }, policies);
  let child;
  for (let n = 0; n < ADDED; n++) child = add(HISTORY + n);
  protectHistory(root, { commit: child }, policies);
  assert.ok(walked() <= ADDED, `the second scan walked ${walked()} commits, more than the ${ADDED} added`);
});
