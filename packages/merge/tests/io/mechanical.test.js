/** Plan shard conflicts resolve only when their rows compose without data loss [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveMechanicalIndex, formatJson } from '../../index.js';
import { fixture, git } from '../../../landing/tests/fixtures/plan.js';

const FILE = 'packages/codemap/data/plan/14-state.json';
const row = (name, target = `packages/state/src/${name}.js`) => [`src/${name}.js`, target, 'rule'];
const shard = paths => formatJson({ order: 8, name: 'state', paths }) + '\n';

/** Create two real branches from one base and leave their merge stages in the fixture index. */
function conflictIndex(t, baseSource, leftSource, rightSource) {
  const { root, put } = fixture(t);
  git(root, 'config', 'user.name', 'Mechanical merge fixture');
  git(root, 'config', 'user.email', 'mechanical@example.invalid');
  put(FILE, baseSource);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  const heads = [leftSource, rightSource].map((source, index) => {
    git(root, 'checkout', '-q', '-b', `side${index}`, base);
    if (source === null) git(root, 'rm', '-q', FILE);
    else put(FILE, source);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `side ${index}`);
    return git(root, 'rev-parse', 'HEAD');
  });
  git(root, 'checkout', '-q', '--detach', base);
  git(root, 'read-tree', '-m', base, heads[0], heads[1]);
  return { root };
}

test('merge.io-plan-shard-conflicts.disjoint-appends: independent rows compose through the real merge index [C7]', t => {
  const base = shard([row('base')]);
  const { root } = conflictIndex(t, base, shard([row('base'), row('left')]), shard([row('base'), row('right')]));
  const result = resolveMechanicalIndex(root, [FILE]);
  assert.deepEqual(result.files, []);
  assert.deepEqual(JSON.parse(readFileSync(join(root, FILE), 'utf8')).paths, [row('base'), row('left'), row('right')]);
});

test('merge.io-plan-shard-conflicts.divergent-edits: edits to one existing row remain a conflict [C7]', t => {
  const base = shard([row('same')]);
  const { root } = conflictIndex(t, base, shard([row('same', 'packages/state/src/left.js')]), shard([row('same', 'packages/state/src/right.js')]));
  assert.deepEqual(resolveMechanicalIndex(root, [FILE]).files, [FILE]);
});

test('merge.io-plan-shard-conflicts.divergent-additions: different definitions of one new row remain a conflict [C7]', t => {
  const base = shard([row('base')]);
  const { root } = conflictIndex(t, base, shard([row('base'), row('new', 'packages/state/src/left.js')]), shard([row('base'), row('new', 'packages/state/src/right.js')]));
  assert.deepEqual(resolveMechanicalIndex(root, [FILE]).files, [FILE]);
});

test('merge.io-plan-shard-conflicts.deletion-versus-editing: a deletion and an edit remain conflicts in both orders [C7]', t => {
  const base = shard([row('base'), row('other')]);
  for (const [left, right] of [
    [null, shard([row('base', 'packages/state/src/changed.js'), row('other')])],
    [shard([row('base', 'packages/state/src/changed.js'), row('other')]), null],
  ]) {
    const { root } = conflictIndex(t, base, left, right);
    assert.deepEqual(resolveMechanicalIndex(root, [FILE]).files, [FILE]);
  }
});
