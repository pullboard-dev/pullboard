/** Key memo pruning: old memo folders go, fresh ones stay, rebuilds stay correct [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoizedActionKeys } from '../packages/gate/src/shell/test-action-key-memo.js';

const KEY = 'a'.repeat(64);
const build = async () => new Map([['t.test.js', { key: KEY, reason: 'x' }]]);

test('clause 2: an old memo folder is pruned, a fresh one kept, and the old tree still gets correct keys [C7]', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memo-prune-'));
  await memoizedActionKeys(store, 'old-tree', ['t.test.js'], build);
  await memoizedActionKeys(store, 'fresh-tree', ['t.test.js'], build);
  const old = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(join(store, 'keys', 'old-tree'), old, old);
  // A second call within 10 minutes does not prune yet; age the marker out.
  utimesSync(join(store, 'keys', '.pruned'), old, old);
  await memoizedActionKeys(store, 'fresh-tree', ['t.test.js'], build);
  assert.equal(existsSync(join(store, 'keys', 'old-tree')), false);
  assert.equal(existsSync(join(store, 'keys', 'fresh-tree')), true);
  const again = await memoizedActionKeys(store, 'old-tree', ['t.test.js'], build);
  assert.equal(again.get('t.test.js').key, KEY);
});

test('clause 1: pruning runs at most once per 10 minutes [C7]', async () => {
  const store = mkdtempSync(join(tmpdir(), 'memo-prune-'));
  await memoizedActionKeys(store, 'old-tree', ['t.test.js'], build);
  const old = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(join(store, 'keys', 'old-tree'), old, old);
  await memoizedActionKeys(store, 'other', ['t.test.js'], build);
  assert.equal(existsSync(join(store, 'keys', 'old-tree')), true);
});
