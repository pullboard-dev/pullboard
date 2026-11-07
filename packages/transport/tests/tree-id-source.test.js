/** Gates send a candidate's tree id; a runner's store takes only the objects it lacks [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../test/fixture-child.js';
import { runFixtureGit } from '../../../test/fixture-child.js';
import { treeOf } from '../../pin/index.js';
import { runnerObjectStore } from '../index.js';
import { sendTree } from '../index.js';

/** Build a throwaway repository with two commits that change one file, and return the repo and both tree ids. */
function repoWithTwoBases() {
  const files = privateFixtureFiles('pullboard-tree-source-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'tree@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Tree Test']);
  files.write('keep/one.txt', 'one\n');
  files.write('keep/two.txt', 'two\n');
  files.write('src/a.txt', 'a1\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'first']);
  const first = treeOf(repo, 'HEAD');
  files.write('src/a.txt', 'a2\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'second']);
  return { repo, first, second: treeOf(repo, 'HEAD') };
}

test('clause 1: a gate sends the candidate tree id and the runner materialises only the objects it lacks, a second gate on the same base sending only the changed objects [C7]', () => {
  const { repo, first, second } = repoWithTwoBases();
  const store = runnerObjectStore(join(privateFixtureFiles('pullboard-tree-store-').root, 'objects.git'));

  const one = sendTree({ repo, tree: first, store });
  assert.equal(one.reused, 0, 'an empty store holds none of the first tree');
  assert.equal(one.sent, one.total);
  assert.deepEqual(store.missing(runFixtureGit(['-C', repo, 'rev-list', '--objects', first]).split('\n').map(line => line.split(' ')[0])), []);

  const again = sendTree({ repo, tree: first, store });
  assert.equal(again.sent, 0, 'the same tree sent twice moves nothing');
  assert.equal(again.bytes, 0);

  const two = sendTree({ repo, tree: second, store });
  assert.equal(two.sent, 3, 'only the changed blob, the src tree and the root tree move');
  assert.equal(two.reused, two.total - 3);
  assert.ok(two.bytes < one.bytes, 'the second gate sends no more than the first');

  const folder = join(privateFixtureFiles('pullboard-tree-out-').root, 'source');
  store.materialise(second, folder);
  assert.equal(readFileSync(join(folder, 'src/a.txt'), 'utf8'), 'a2\n');
  assert.equal(readFileSync(join(folder, 'keep/one.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(folder, '.git')), false, 'the source folder carries no repository');
});

test('clause 1: a bad tree id, an unknown tree or a tree the store never received is refused with a code [C7]', () => {
  const { repo, second } = repoWithTwoBases();
  const store = runnerObjectStore(join(privateFixtureFiles('pullboard-tree-bad-').root, 'objects.git'));
  assert.throws(() => sendTree({ repo, tree: '../escape', store }), { code: 'TREE_SOURCE_INVALID' });
  assert.throws(() => sendTree({ repo, tree: '0'.repeat(40), store }), { code: 'TREE_SOURCE_UNKNOWN_TREE' });
  assert.throws(() => store.materialise(second, join(privateFixtureFiles('pullboard-tree-none-').root, 'x')), { code: 'TREE_SOURCE_MISSING' });
});
