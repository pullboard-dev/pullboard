/** @pullboard-test-input apps/cli/src/io/disk/use.js packages/gate/data/baselines/stores.json */
/** @pullboard-world-pin reads the disk module's own source to prove it names no store by hand. */
/** Disk use is reported per store with a warning threshold, and retention ages out raw material but never a referenced record [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DISK_STORES } from '../../../src/io/disk/use.js';
import { diskLines } from '../../../src/io/disk/use.js';
import { diskPolicy } from '../../../src/io/disk/use.js';
import { MEASURE_LOCK } from '../../../src/io/disk/use.js';
import { cachedDiskUse } from '../../../src/io/disk/use.js';
import { diskUse } from '../../../src/io/disk/use.js';
import { startDiskMeasure } from '../../../src/io/disk/use.js';
import { pruneDisk } from '../../../src/io/disk/use.js';
import { refusingBadPolicy } from '../../../src/io/disk/use.js';
import { diskStoresFrom } from '../../../../../packages/gate/index.js';
import { storeRegistry } from '../../../../../packages/gate/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureChild } from '../../fixtures/child.js';

const MB = 1024 * 1024;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const DAYS = (n) => (NOW - n * 86_400_000) / 1000;

/** Write a file of a size and age. */
function put(path, megabytes, ageDays) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(megabytes * MB, 1));
  utimesSync(path, DAYS(ageDays), DAYS(ageDays));
}

/** A fixture .git/pullboard with each store populated. */
function fixture(t) {
  const dir = privateFixtureFiles('pullboard-disk-use-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  put(join(dir, 'board.sqlite'), 1, 0);
  put(join(dir, 'worktree-archives', 'arch-old-1111', 'tree.bin'), 6, 90);
  put(join(dir, 'test-actions', 'action-old-2222.log'), 3, 40);
  put(join(dir, 'test-actions', 'action-kept-3333.log'), 3, 40);
  put(join(dir, 'test-actions', 'action-new-4444.log'), 3, 1);
  put(join(dir, 'flake-evidence', 'flake-old-5555', 'a.log'), 2, 60);
  writeFileSync(join(dir, 'gate-receipts.jsonl'), JSON.stringify({ id: 1, log: 'action-kept-3333.log' }) + '\n');
  return dir;
}

test('status and stats report each store and the total on a fixture board [C7]', (t) => {
  const dir = fixture(t);
  const use = diskUse(dir, { now: NOW });
  const by = Object.fromEntries(use.stores.map(row => [row.name, row.bytes]));
  assert.ok(by['worktree archives'] >= 6 * MB);
  assert.ok(by['test actions'] >= 9 * MB);
  assert.ok(by['flake evidence'] >= 2 * MB);
  assert.ok(by['board database'] >= 1 * MB);
  assert.ok(by.receipts > 0);
  assert.equal(use.total, use.stores.reduce((sum, row) => sum + row.bytes, 0));
  assert.equal(use.warning, null);
  assert.match(diskLines(use)[0], /total \(.*test actions.*worktree archives.*\)/u);
});

test('crossing the threshold warns naming the largest stores [C7]', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'disk-policy.json'), JSON.stringify({ warnBytes: 5 * MB }));
  const use = diskUse(dir, { now: NOW });
  assert.deepEqual(use.warning.largest.slice(0, 2), ['test actions', 'worktree archives']);
  assert.match(diskLines(use).join('\n'), /disk warning: .*test actions, worktree archives/u);
});

test('a bad policy file is refused with its next step [C7]', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'disk-policy.json'), JSON.stringify({ warnBytes: -1 }));
  assert.throws(() => diskPolicy(dir), (error) => error.code === 'DISK_POLICY_INVALID' && /fix or delete/u.test(error.message));
  assert.throws(() => refusingBadPolicy(() => diskPolicy(dir), Refused), (error) => error instanceof Refused && error.code === 'DISK_POLICY_INVALID');
});

test('retention removes an aged raw log but never a referenced receipt or record, and logs each removal [C7]', (t) => {
  const dir = fixture(t);
  const result = pruneDisk(dir, { now: NOW });
  const names = result.removed.map(row => row.entry).sort();
  assert.deepEqual(names, ['action-old-2222.log', 'arch-old-1111', 'flake-old-5555']);
  assert.ok(!existsSync(join(dir, 'test-actions', 'action-old-2222.log')));
  assert.ok(existsSync(join(dir, 'test-actions', 'action-new-4444.log')), 'a young log stays');
  // Negative control: an aged log a receipt names is kept, and so are the receipt, ledger and board rows.
  assert.ok(existsSync(join(dir, 'test-actions', 'action-kept-3333.log')));
  assert.ok(result.kept.some(row => row.entry === 'action-kept-3333.log'));
  assert.ok(existsSync(join(dir, 'gate-receipts.jsonl')));
  assert.ok(existsSync(join(dir, 'board.sqlite')));
  const log = readFileSync(join(dir, 'retention-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.length, 3);
  assert.ok(log.every(row => row.store && row.entry && row.bytes > 0 && /older than/u.test(row.reason)));
});

test('a folder that cannot be removed is kept with its reason and the prune goes on [C7]', (t) => {
  const dir = fixture(t);
  const locked = join(dir, 'test-actions', 'locked-6666');
  put(join(locked, 'inner.log'), 1, 40);
  utimesSync(locked, DAYS(40), DAYS(40));
  chmodSync(locked, 0o555);
  if (process.getuid?.() === 0) return t.skip('root removes a read-only folder');
  let result;
  try { result = pruneDisk(dir, { now: NOW }); } finally { chmodSync(locked, 0o755); }
  const row = result.kept.find(item => item.entry === 'locked-6666');
  assert.ok(row && /written to during removal/u.test(row.reason), 'the failed entry is kept with a reason');
  assert.ok(existsSync(join(locked, 'inner.log')));
  assert.ok(!result.removed.some(item => item.entry === 'locked-6666'), 'its bytes are not counted as freed');
  assert.deepEqual(result.removed.map(item => item.entry).sort(), ['action-old-2222.log', 'arch-old-1111', 'flake-old-5555']);
  assert.ok(!existsSync(join(dir, 'test-actions', 'action-old-2222.log')), 'the others are still removed');
});

test('retention over a size limit removes the oldest unreferenced entries first and a dry run removes nothing [C7]', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'disk-policy.json'), JSON.stringify({ retention: { 'test actions': { maxAgeDays: 3650, maxBytes: 7 * MB } } }));
  const dry = pruneDisk(dir, { now: NOW, dryRun: true });
  assert.deepEqual(dry.removed.filter(row => row.store === 'test actions').map(row => row.entry), ['action-old-2222.log']);
  assert.ok(existsSync(join(dir, 'worktree-archives', 'arch-old-1111')), 'a dry run removes nothing');
  assert.ok(existsSync(join(dir, 'test-actions', 'action-old-2222.log')));
  const real = pruneDisk(dir, { now: NOW });
  assert.ok(real.removed.some(row => row.entry === 'action-old-2222.log' && /over its/u.test(row.reason)));
  assert.ok(existsSync(join(dir, 'test-actions', 'action-kept-3333.log')));
});

test('clause 1: status never walks the stores itself: it shows the last measurement and starts a stale one in the background [C7]', (t) => {
  const dir = fixture(t);
  const started = [];
  const start = (path) => { started.push(path); return true; };
  const first = cachedDiskUse(dir, { now: NOW, start });
  assert.equal(first.total, null, 'no measurement yet is shown as none, never measured in the command');
  assert.equal(first.measuring, true);
  assert.deepEqual(started, [dir], 'a missing measurement starts one');
  assert.match(diskLines(first)[0], /being measured in the background/u);
  const measured = diskUse(dir, { now: NOW });
  started.length = 0;
  const fresh = cachedDiskUse(dir, { now: NOW + 60_000, start });
  assert.equal(fresh.total, measured.total);
  assert.deepEqual(fresh.stores, measured.stores);
  assert.deepEqual(started, [], 'a fresh measurement starts nothing');
  const stale = cachedDiskUse(dir, { now: NOW + 11 * 60_000, start });
  assert.equal(stale.total, measured.total, 'a stale measurement is still shown');
  assert.deepEqual(started, [dir], 'and a new one starts in the background');
});

test('clause 1: one background measurement runs at a time and writes the figures status shows [C7]', (t) => {
  const dir = fixture(t);
  const launched = [];
  // Hold the launched worker until the second start has been tried, then run it to completion.
  assert.equal(startDiskMeasure(dir, { launch: (entry, { args }) => { launched.push([entry, args]); return 1; } }), true);
  assert.equal(startDiskMeasure(dir, { launch: () => assert.fail('a second start while one runs launches nothing') }), false);
  const [[entry, args]] = launched;
  const worker = runFixtureChild(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.equal(worker.status, 0, worker.stderr);
  assert.ok(!existsSync(join(dir, MEASURE_LOCK)), 'the measurement freed its lock');
  const shown = cachedDiskUse(dir, { start: () => assert.fail('a fresh measurement starts nothing') });
  // The measurement wrote its own cache file after walking, so only the stores it measured are compared.
  const now = diskUse(dir);
  assert.deepEqual(shown.stores.filter(row => row.name !== 'other'), now.stores.filter(row => row.name !== 'other'));
  assert.ok(shown.stores.some(row => row.name === 'test actions'));
});

test('retention walks a folder of 200000 entries without a stack overflow and finds its newest file [C7]', (t) => {
  const dir = fixture(t);
  const big = join(dir, 'flake-evidence', 'flake-big-6666');
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 200_000; i++) {
    const file = join(big, `f${i}`);
    writeFileSync(file, '');
    utimesSync(file, DAYS(90), DAYS(90));
  }
  // The one fresh file is the newest; if the walk lost it the entry would look 90 days old and be removed.
  utimesSync(join(big, 'f123456'), DAYS(5), DAYS(5));
  const result = pruneDisk(dir, { now: NOW, dryRun: true });
  assert.ok(!result.removed.some(row => row.entry === 'flake-big-6666'), 'a folder holding a fresh file is not aged');
  assert.ok(result.removed.some(row => row.entry === 'flake-old-5555'), 'an all-old folder is still removed');
});

test('#6738 clause 1: DISK_STORES comes from stores.json and the file holds no hand-written store list [C7]', () => {
  const source = readFileSync(new URL('../../../src/io/disk/use.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'worktree-archives'|'check-receipts'|'board\.sqlite'/u, 'no store name is written in the module');
  const registry = storeRegistry();
  assert.deepEqual(DISK_STORES, diskStoresFrom(registry));
  assert.ok(DISK_STORES['worktree archives'].includes('worktree-archives') && DISK_STORES.receipts.includes('landings'));
});

test('#6738 clause 2: every store in stores.json is in DISK_STORES under its disk group, so a missing one fails [C7]', () => {
  const registry = storeRegistry();
  for (const [name, row] of Object.entries(registry.dirs)) assert.ok(typeof row.disk === 'string', `directory store ${name} names its disk group (or other)`);
  for (const rows of [registry.stores, registry.dirs]) {
    for (const [name, row] of Object.entries(rows)) {
      if (row.disk && row.disk !== 'other') assert.ok(DISK_STORES[row.disk]?.includes(name), `${name} is in DISK_STORES under ${row.disk}`);
    }
  }
  const without = structuredClone(registry);
  delete without.dirs['worktree-archives'].disk;
  assert.ok(!diskStoresFrom(without)['worktree archives'].includes('worktree-archives'), 'a row without a group falls out of its group');
});
