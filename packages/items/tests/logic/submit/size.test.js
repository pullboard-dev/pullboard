/** The item size note counts only the item's own changes, not main moving on after the merge [C7,#11789]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { changedLines } from '../../../index.js';
import { oversizeNote } from '../../../index.js';

const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';

/** A repo where the head branched off main with its own lines, merged main (20 more lines), then main moved on by 300. */
function movedOn(ownLines) {
  const files = privateFixtureFiles('pullboard-size-note-');
  const root = files.root;
  const run = (...args) => runFixtureGit([...IDENT, ...args], { cwd: root });
  const commit = (name, text) => { files.write(name, text); run('add', '.'); run('commit', '-qm', `test: ${name}`); };
  run('init', '-q', '-b', 'main');
  commit('base.txt', 'base\n');
  run('checkout', '-qb', 'item');
  commit('own.txt', lines(ownLines, 'own'));
  run('checkout', '-q', 'main');
  commit('early.txt', lines(20, 'early'));
  run('checkout', '-q', 'item');
  run('merge', '-q', '--no-edit', 'main');
  const head = run('rev-parse', 'HEAD');
  run('checkout', '-q', 'main');
  commit('late.txt', lines(300, 'late'));
  return { root, head, base: run('rev-parse', 'HEAD') };
}

test('items.submit-size.main-merge-not-counted: clause 1: a head that merged main, after which main moved on by 300 lines, counts only its own lines and a 40-line item gets no note [C7,#11789]', () => {
  const { root, head, base } = movedOn(40);
  assert.equal(changedLines(root, base, head), 40);
  assert.equal(oversizeNote(changedLines(root, base, head)), null);
});

test('items.submit-size.own-lines-counted: clause 2: a head with 250 lines of its own still counts them and gets the split note [C7,#11789]', () => {
  const { root, head, base } = movedOn(250);
  assert.equal(changedLines(root, base, head), 250);
  assert.match(oversizeNote(changedLines(root, base, head)), /consider splitting/);
});
