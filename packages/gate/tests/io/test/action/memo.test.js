/** Key memo pruning: one machine-wide atomic turn, old memo folders go, fresh ones stay, rebuilds stay correct [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../../apps/cli/tests/fixtures/board.js';
import { memoizedActionKeys } from '../../../../src/io/test/action/memo.js';

const MODULE = new URL('../../../../src/io/test/action/memo.js', import.meta.url).href;
const KEY = 'a'.repeat(64);
const build = async () => new Map([['t.test.js', { key: KEY, reason: 'x' }]]);
const HOURS = 3_600_000;

/** Point the machine-wide marker at a fresh folder for this test. */
function isolate() {
  const home = temporaryDirectory('memo-machine-');
  process.env.PULLBOARD_MACHINE_HOME = home;
  return join(home, 'key-memo-prune');
}

/** Make a store holding one memo folder aged three hours. */
function storeWithOldMemo() {
  const store = temporaryDirectory('memo-prune-');
  mkdirSync(join(store, 'keys', 'old-tree'), { recursive: true });
  const old = new Date(Date.now() - 3 * HOURS);
  utimesSync(join(store, 'keys', 'old-tree'), old, old);
  return store;
}

/** Age the single marker so the next caller finds it stale. */
function ageMarker(directory) {
  const [marker] = readdirSync(directory);
  renameSync(join(directory, marker), join(directory, `prune-${Date.now() - 3 * HOURS}`));
}

/** Run pruneKeyMemos for a store in its own process; resolves to what it printed. */
function pruneInProcess(store, home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { pruneKeyMemos } from ${JSON.stringify(MODULE)}; console.log(pruneKeyMemos(process.argv[1]));`, store],
    { env: { ...process.env, PULLBOARD_MACHINE_HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', () => resolve(out.trim()));
  });
}

test('clause 3: an old memo folder is pruned, a fresh one kept, and the old tree still gets correct keys [C7]', async () => {
  const marker = isolate();
  const store = temporaryDirectory('memo-prune-');
  await memoizedActionKeys(store, 'old-tree', ['t.test.js'], build);
  await memoizedActionKeys(store, 'fresh-tree', ['t.test.js'], build);
  const old = new Date(Date.now() - 3 * HOURS);
  utimesSync(join(store, 'keys', 'old-tree'), old, old);
  ageMarker(marker);
  await memoizedActionKeys(store, 'fresh-tree', ['t.test.js'], build);
  assert.equal(existsSync(join(store, 'keys', 'old-tree')), false);
  assert.equal(existsSync(join(store, 'keys', 'fresh-tree')), true);
  const again = await memoizedActionKeys(store, 'old-tree', ['t.test.js'], build);
  assert.equal(again.get('t.test.js').key, KEY);
});

test('clause 1: pruning runs at most once per 10 minutes, with one machine-wide marker and no lock file [C7]', async () => {
  const marker = isolate();
  const store = storeWithOldMemo();
  await memoizedActionKeys(store, 'first', ['t.test.js'], build);
  assert.equal(existsSync(join(store, 'keys', 'old-tree')), false, 'the first call on a machine takes the turn');
  mkdirSync(join(store, 'keys', 'old-again'));
  const old = new Date(Date.now() - 3 * HOURS);
  utimesSync(join(store, 'keys', 'old-again'), old, old);
  await memoizedActionKeys(store, 'second', ['t.test.js'], build);
  assert.equal(existsSync(join(store, 'keys', 'old-again')), true, 'a call inside the window does not prune');
  assert.deepEqual(readdirSync(marker).filter(name => !/^prune-\d+$/u.test(name)), [], 'only the one marker file lives there');
  assert.equal(readdirSync(marker).length, 1);
});

test('clause 2: six processes racing for the same expired marker produce exactly one prune pass [C7]', async () => {
  const marker = isolate();
  const home = process.env.PULLBOARD_MACHINE_HOME;
  const store = storeWithOldMemo();
  await memoizedActionKeys(store, 'seed', ['t.test.js'], build);
  ageMarker(marker);
  const results = await Promise.all(Array.from({ length: 6 }, () => pruneInProcess(store, home)));
  assert.equal(results.filter(result => result === 'true').length, 1, `results: ${results}`);
});

test('clause 2: two repositories on one host racing from no marker produce exactly one prune pass [C7]', async () => {
  isolate();
  const home = process.env.PULLBOARD_MACHINE_HOME;
  const stores = [storeWithOldMemo(), storeWithOldMemo()];
  const results = await Promise.all([...stores, ...stores, ...stores].map(store => pruneInProcess(store, home)));
  assert.equal(results.filter(result => result === 'true').length, 1, `results: ${results}`);
});
