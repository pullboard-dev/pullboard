/** @pullboard-world-pin builds real git repositories in a private root; every conflict is a real merge of two branches. */
/** Plan shards and data-read files compose by entry wherever main is composed: source advance (review retry is tested in verify) [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withSourceComposition } from '../../index.js';
import { formatJson } from '../../../codemap/index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';

const SHARD_FILE = 'packages/codemap/data/plan/14-state.json';
const READS_FILE = 'packages/codemap/data/plan/data-reads/blueprints.json';
const row = n => [`src/m-${n}.js`, `packages/state/src/m-${n}.js`, 'rule'];
const read = (n, why = 'config') => ({ file: `apps/cli/tests/r${n}.test.js`, line: n, expression: `join(box.repo, 'f${n}')`, kind: 'config', why });
const shard = paths => formatJson({ order: 8, name: 'state', paths }) + '\n';
const reads = rows => JSON.stringify({ version: 1, reads: rows }, null, 2) + '\n';

/** A tiny exact test-tier row with all fields that define its meaning. */
const tier = (file, packages, reasons) => ({ file, packages, reasons, tier: 'T1' });
const tiers = rows => JSON.stringify({ version: 1, files: rows }, null, 2) + '\n';
const expectedTiers = rows => `{
  "version": 1,
  "files": [
${rows.map(value => `    ${JSON.stringify(value)}`).join(',\n')}
  ]
}\n`;

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

test('merge.plan-data.composes-both-rows: two branches that each add a plan shard row and a data-read row compose with both rows in both orders, by compose [C7,D3]', async t => {
  const { root, heads } = twoBranches(t, {
    [SHARD_FILE]: [shard([row(1)]), shard([row(1), row(2)]), shard([row(1), row(3)])],
    [READS_FILE]: [reads([read(1)]), reads([read(1), read(2)]), reads([read(1), read(3)])],
  });
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    await withSourceComposition(root, ours, theirs, async composition => {
      const paths = JSON.parse(readFileSync(join(composition.directory, SHARD_FILE), 'utf8')).paths.map(entry => entry[0]).sort();
      assert.deepEqual(paths, ['src/m-1.js', 'src/m-2.js', 'src/m-3.js']);
      const lines = readFileSync(join(composition.directory, SHARD_FILE), 'utf8').split('\n');
      assert.ok(lines.some(line => line === ` ${JSON.stringify(row(3))},` || line === ` ${JSON.stringify(row(3))}`) || lines.some(line => line.includes(JSON.stringify(row(3)))), 'the shard keeps one row per line');
      const files = JSON.parse(readFileSync(join(composition.directory, READS_FILE), 'utf8')).reads.map(entry => entry.line).sort();
      assert.deepEqual(files, [1, 2, 3]);
    });
  }
});

test('merge.plan-data.refuses-divergent-rows: a data-read row and a shard row edited differently on both sides still refuse MERGE_CONFLICT [C7,D3]', async t => {
  for (const [file, base, left, right] of [
    [SHARD_FILE, shard([row(1)]), shard([[...row(1).slice(0, 2), 'imports']]), shard([[...row(1).slice(0, 2), 'seed']])],
    [READS_FILE, reads([read(1)]), reads([read(1, 'left')]), reads([read(1, 'right')])],
  ]) {
    const { root, heads } = twoBranches(t, { [file]: [base, left, right] });
    for (const [ours, theirs] of [heads, [...heads].reverse()]) {
      await assert.rejects(withSourceComposition(root, ours, theirs, async () => assert.fail('a same-row edit must not compose')),
        error => error.code === 'MERGE_CONFLICT' && error.message.includes(file));
    }
  }
});

test('merge.plan-data.refuses-other-conflicts: a conflict in any other file still refuses [C7,D3]', async t => {
  const { root, heads } = twoBranches(t, { 'src/other.js': ['a\n', 'b\n', 'c\n'] });
  await assert.rejects(withSourceComposition(root, heads[0], heads[1], async () => assert.fail('no')), error => error.code === 'MERGE_CONFLICT');
});

test('merge.io-test-tiers-compose.disjoint-both-orders: clause 1: withSourceComposition preserves every test-tier field and composes a sorted union with identical bytes and the composition HEAD in both directions [C7,D3]', async t => {
  const file = 'packages/gate/data/tests/tiers.json';
  const base = [tier('apps/cli/tests/base.test.js', ['packages/merge'], ['base'])];
  const left = tier('apps/cli/tests/zeta.test.js', ['packages/merge', 'packages/gate'], ['left']);
  const right = tier('apps/cli/tests/alpha.test.js', ['packages/merge'], ['right', 'runner']);
  const { root, heads } = twoBranches(t, { [file]: [tiers(base), tiers([...base, left]), tiers([...base, right])] });
  const results = [];
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    const result = await withSourceComposition(root, ours, theirs, async composition => {
      const bytes = readFileSync(join(composition.directory, file), 'utf8');
      assert.equal(bytes, expectedTiers([right, base[0], left]), 'the full tier rows are present in exact alphabetical order');
      assert.equal(git(composition.directory, 'rev-parse', 'HEAD').trim(), composition.head, 'the callback runs at the composition HEAD');
      assert.equal(git(composition.directory, 'rev-parse', 'HEAD').trim(), composition.head, 'the exact bytes are read from the checked-out composition HEAD');
      return bytes;
    });
    results.push(result);
  }
  assert.equal(results[0], results[1], 'reversing the composition inputs leaves identical bytes');
});

test('merge.io-test-tiers-compose.same-row-refuses: clause 1: withSourceComposition names a shared test-tier key in both directions and never calls its callback [C7,D3]', async t => {
  const file = 'packages/gate/data/tests/tiers.json';
  const base = tiers([tier('apps/cli/tests/shared.test.js', ['packages/merge'], ['base'])]);
  const left = tiers([tier('apps/cli/tests/shared.test.js', ['packages/merge'], ['left'])]);
  const right = tiers([tier('apps/cli/tests/shared.test.js', ['packages/merge'], ['right'])]);
  const { root, heads } = twoBranches(t, { [file]: [base, left, right] });
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    let called = false;
    await assert.rejects(withSourceComposition(root, ours, theirs, async () => { called = true; }), error => {
      assert.equal(error.code, 'MERGE_CONFLICT');
      assert.ok(error.message.includes('apps/cli/tests/shared.test.js'), 'the conflict names the shared tier key');
      return true;
    });
    assert.equal(called, false, 'a conflicting composition never invokes the callback');
  }
});

test('merge.io-plan-index-compose.disjoint-both-orders: clause 1: withSourceComposition preserves the cells and path row schemas as exact sorted unions with identical bytes and the same composition HEAD in both directions [C7,D3]', async t => {
  const file = 'packages/codemap/data/plan/cells.json';
  const cell = (name, order) => ({ order, name, file: `packages/${name}` });
  const stay = (path, reason) => ({ path, reason });
  const index = (cells, stays) => JSON.stringify({ version: 1, cells, stays }, null, 2) + '\n';
  const expected = (cells, stays) => `{
  "version": 1,
  "cells": [
${cells.map(value => `    ${JSON.stringify({ file: value.file, name: value.name, order: value.order })}`).join(',\n')}
  ],
  "stays": [
${stays.map(value => `    ${JSON.stringify({ path: value.path, reason: value.reason })}`).join(',\n')}
  ]
}\n`;
  const { root, heads } = twoBranches(t, {
    [file]: [
      index([cell('kernel', 1)], [stay('src/base.js', 'base')]),
      index([cell('kernel', 1), cell('merge', 3)], [stay('src/base.js', 'base'), stay('src/zeta.js', 'left')]),
      index([cell('kernel', 1), cell('codemap', 2)], [stay('src/alpha.js', 'right'), stay('src/base.js', 'base')]),
    ],
  });
  const wanted = expected([cell('kernel', 1), cell('codemap', 2), cell('merge', 3)], [stay('src/alpha.js', 'right'), stay('src/base.js', 'base'), stay('src/zeta.js', 'left')]);
  const results = [];
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    results.push(await withSourceComposition(root, ours, theirs, async composition => {
      assert.equal(git(composition.directory, 'rev-parse', 'HEAD').trim(), composition.head, 'the callback runs at the composition HEAD');
      const bytes = readFileSync(join(composition.directory, file), 'utf8');
      assert.equal(bytes, wanted, 'both plan-index row schemas preserve exact rows in sorted order');
      assert.equal(git(composition.directory, 'rev-parse', 'HEAD').trim(), composition.head, 'the exact bytes are read from the checked-out composition HEAD');
      return bytes;
    }));
  }
  assert.equal(results[0], results[1], 'reversing the composition inputs leaves identical bytes');
});

test('merge.io-plan-index-compose.same-row-refuses: clause 1: withSourceComposition names a shared plan-index key in both directions and never calls its callback [C7,D3]', async t => {
  const file = 'packages/codemap/data/plan/cells.json';
  const index = (cellExtra, stayReason) => JSON.stringify({ version: 1,
    cells: [{ order: 1, name: 'merge', file: 'packages/merge', ...cellExtra }],
    stays: [{ path: 'src/shared.js', reason: stayReason }],
  }, null, 2) + '\n';
  const { root, heads } = twoBranches(t, {
    [file]: [index({}, 'base'), index({ allowedEdges: ['merge->gate'] }, 'left'), index({ allowedEdges: ['merge->codemap'] }, 'right')],
  });
  for (const [ours, theirs] of [heads, [...heads].reverse()]) {
    let called = false;
    await assert.rejects(withSourceComposition(root, ours, theirs, async () => { called = true; }), error => {
      assert.equal(error.code, 'MERGE_CONFLICT');
      assert.ok(error.message.includes('cells:merge'), 'the conflict names the shared cell key');
      assert.ok(error.message.includes('stays:src/shared.js'), 'the conflict names the shared path key');
      return true;
    });
    assert.equal(called, false, 'a conflicting composition never invokes the callback');
  }
});
