/** Disk use is reported per store with a warning threshold, and retention ages out raw material but never a referenced record [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { diskLines } from '../apps/cli/src/shell/disk-use.js';
import { diskPolicy } from '../apps/cli/src/shell/disk-use.js';
import { diskUse } from '../apps/cli/src/shell/disk-use.js';
import { pruneDisk } from '../apps/cli/src/shell/disk-use.js';
import { refusingBadPolicy } from '../apps/cli/src/shell/disk-use.js';
import { Refused } from '../packages/kernel/index.js';
import { privateFixtureFiles } from './fixture-child.js';

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
