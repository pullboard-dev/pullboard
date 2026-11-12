/** Runner disk admission refuses only below an absolute free-space floor, never on a percentage of the disk [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MIN_FREE_BYTES } from '../../../src/io/sweep.js';
import { assertDiskFree } from '../../../src/io/sweep.js';
import { diskFloorBytes } from '../../../src/io/sweep.js';
import { sweepRunnerDisk } from '../../../src/io/sweep.js';

const GIB = 1024 ** 3;

/** A runner root with no jobs, no repos and no cache, so a sweep only reports the disk. */
function emptyRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-disk-floor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'jobs'));
  return root;
}

/** Sweep an empty root on a pretend disk and return the report. */
function sweepOn(root, disk, options = {}) {
  return sweepRunnerDisk(root, { machineHome: join(root, 'machine'), census: () => new Map(), diskFree: () => disk, ...options });
}

test('36 GB free on a large disk admits the job even though it is under a fifth of the disk [C7]', async t => {
  const report = await sweepOn(emptyRoot(t), { free: 36 * GIB, total: 212 * GIB });
  assert.equal(report.freeBytes, 36 * GIB);
  assert.doesNotThrow(() => assertDiskFree(report));
});

test('5 GB free refuses RUNNER_DISK_FULL below the default 10 GB floor [C7]', async t => {
  const report = await sweepOn(emptyRoot(t), { free: 5 * GIB, total: 100 * GIB });
  assert.throws(() => assertDiskFree(report), error => error.code === 'RUNNER_DISK_FULL' && /5\.0 GB/u.test(error.message));
});

test('a disk that cannot be read still refuses, and the floor is a byte count [C7]', () => {
  assert.throws(() => assertDiskFree({ freeBytes: null }), { code: 'RUNNER_DISK_FULL' });
  assert.throws(() => assertDiskFree(null), { code: 'RUNNER_DISK_FULL' });
  assert.equal(DEFAULT_MIN_FREE_BYTES, 10 * GIB);
  assert.doesNotThrow(() => assertDiskFree({ freeBytes: 10 * GIB }));
  assert.throws(() => assertDiskFree({ freeBytes: 10 * GIB - 1 }), { code: 'RUNNER_DISK_FULL' });
});

test('gate.diskFloorMB in the machine settings sets the floor, and a bad value falls back to 10 GB [C7]', t => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-disk-floor-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(diskFloorBytes(home), 10 * GIB, 'no settings file means the default');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ gate: { diskFloorMB: 2048 } }));
  assert.equal(diskFloorBytes(home), 2 * GIB);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ gate: { diskFloorMB: 'lots' } }));
  assert.equal(diskFloorBytes(home), 10 * GIB, 'an invalid value never becomes a percentage or a zero floor');
});
