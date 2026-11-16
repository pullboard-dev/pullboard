/** @pullboard-test-input source-cell packages/items */
/** A hotfix head already in main's history is composed against its own parent, not main's tip (#9445, #3127). [C7,V4] */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { requireSubmitComposition } from '../../../index.js';

const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

/** A repo with initial -> hotfix -> later on main, and a side branch with one commit that never reached main. */
function history() {
  const files = privateFixtureFiles('pullboard-parent-base-');
  const root = files.root;
  const run = (...args) => runFixtureGit([...IDENT, ...args], { cwd: root }).trim();
  run('init', '-q', '-b', 'main');
  const commit = (name) => { files.write(name, name); run('add', '.'); run('commit', '-qm', `test: ${name}`); return run('rev-parse', 'HEAD'); };
  const initial = commit('initial.txt');
  const hotfix = commit('hotfix.txt');
  const main = commit('later.txt');
  run('checkout', '-qb', 'side', initial);
  const side = commit('side.txt');
  return { root, run, initial, hotfix, main, side };
}

test('clause 1: a head that is an ancestor of main but not its tip passes when the base is its parent [C7,V4]', () => {
  const f = history();
  assert.throws(() => requireSubmitComposition(f.root, f.hotfix, { commit: f.main }, f.main), e => e.code === 'MAIN_NOT_COMPOSED', 'without the parent base the old rule holds');
  assert.doesNotThrow(() => requireSubmitComposition(f.root, f.hotfix, { commit: f.main }, f.main, f.initial));
  assert.throws(() => requireSubmitComposition(f.root, f.hotfix, { commit: f.main }, f.main, f.main), e => e.code === 'MAIN_NOT_COMPOSED', 'a base that is not the head parent is refused');
  assert.throws(() => requireSubmitComposition(f.root, f.hotfix, { commit: f.main }, f.initial, f.initial), e => e.code === 'MAIN_NOT_COMPOSED', 'a different authority snapshot is still refused');
});

test('clause 2: a head not on main still refuses MAIN_NOT_COMPOSED until it contains main [C7,V4]', () => {
  const f = history();
  assert.throws(() => requireSubmitComposition(f.root, f.side, { commit: f.main }, f.main, f.initial), e => e.code === 'MAIN_NOT_COMPOSED', 'the side head is not in main history, so its parent base does not excuse it');
  f.run('merge', '-qm', 'test: composition', f.main);
  const composed = f.run('rev-parse', 'HEAD');
  assert.doesNotThrow(() => requireSubmitComposition(f.root, composed, { commit: f.main }, f.main));
});
