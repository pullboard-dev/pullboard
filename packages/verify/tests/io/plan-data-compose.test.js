/** @pullboard-world-pin builds real git repositories in a private root; every conflict is a real merge of two branches. */
/** Review admission composes plan shards and data-read files by entry [C7,D3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryReviewCommit } from '../../index.js';
import { formatJson } from '../../../codemap/index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';

const SHARD_FILE = 'packages/codemap/data/plan/14-state.json';
const READS_FILE = 'packages/codemap/data/plan/data-reads/blueprints.json';
const row = n => [`src/m-${n}.js`, `packages/state/src/m-${n}.js`, 'rule'];
const read = (n, why = 'config') => ({ file: `apps/cli/tests/r${n}.test.js`, line: n, expression: `join(box.repo, 'f${n}')`, kind: 'config', why });
const shard = paths => formatJson({ order: 8, name: 'state', paths }) + '\n';
const reads = rows => JSON.stringify({ version: 1, reads: rows }, null, 2) + '\n';

/** One real repository whose two branches each change the same files differently from one base commit. */
function twoBranches(t, files) {
  const { root, put } = fixture(t);
  git(root, 'config', 'user.name', 'Plan merge fixture');
  git(root, 'config', 'user.email', 'plan@example.invalid');
  for (const [file, [base]] of Object.entries(files)) put(file, base);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const main = git(root, 'rev-parse', 'HEAD').trim();
  const heads = [0, 1].map(side => {
    git(root, 'checkout', '-q', '-b', `side${side}`, main);
    for (const [file, sources] of Object.entries(files)) put(file, sources[side + 1]);
    git(root, 'commit', '-qam', `side${side}`);
    return git(root, 'rev-parse', 'HEAD').trim();
  });
  git(root, 'checkout', '-q', 'side0');
  return { root, heads };
}

test('two branches that each add a plan shard row and a data-read row compose with both rows in both orders on review retry [C7,D3]', async t => {
  const { root, heads } = twoBranches(t, {
    [SHARD_FILE]: [shard([row(1)]), shard([row(1), row(2)]), shard([row(1), row(3)])],
    [READS_FILE]: [reads([read(1)]), reads([read(1), read(2)]), reads([read(1), read(3)])],
  });
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    const review = retryReviewCommit(root, ours, { commit: theirs });
    assert.equal(JSON.parse(git(root, 'show', `${review}:${READS_FILE}`)).reads.length, 3, 'review admission merges the data-read rows too');
    assert.equal(JSON.parse(git(root, 'show', `${review}:${SHARD_FILE}`)).paths.length, 3, 'and the shard rows');
  }
});

test('a data-read row and a shard row edited differently on both sides still refuse MERGE_CONFLICT on review retry [C7,D3]', async t => {
  for (const [file, base, left, right] of [
    [SHARD_FILE, shard([row(1)]), shard([[...row(1).slice(0, 2), 'imports']]), shard([[...row(1).slice(0, 2), 'seed']])],
    [READS_FILE, reads([read(1)]), reads([read(1, 'left')]), reads([read(1, 'right')])],
  ]) {
    const { root, heads } = twoBranches(t, { [file]: [base, left, right] });
    for (const [ours, theirs] of [heads, [...heads].reverse()]) {
      assert.throws(() => retryReviewCommit(root, ours, { commit: theirs }), error => error.code === 'MERGE_CONFLICT' && error.message.includes(file));
    }
  }
});
