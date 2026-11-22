/** Runner disk admission refuses only below an absolute free-space floor, never on a percentage of the disk [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
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

test('runner.floor.a-36-gb-free-on-a-large-disk: 36 GB free on a large disk admits the job even though it is under a fifth of the disk [C7]', async t => {
  const report = await sweepOn(emptyRoot(t), { free: 36 * GIB, total: 212 * GIB });
  assert.equal(report.freeBytes, 36 * GIB);
  assert.doesNotThrow(() => assertDiskFree(report));
});

test('runner.floor.a-5-gb-free-refuses-runner-disk-full: 5 GB free refuses RUNNER_DISK_FULL below the default 10 GB floor [C7]', async t => {
  const report = await sweepOn(emptyRoot(t), { free: 5 * GIB, total: 100 * GIB });
  assert.throws(() => assertDiskFree(report), error => error.code === 'RUNNER_DISK_FULL' && /5\.0 GB/u.test(error.message));
});

test('runner.floor.a-disk-that-cannot-be-read-still: a disk that cannot be read still refuses, and the floor is a byte count [C7]', () => {
  assert.throws(() => assertDiskFree({ freeBytes: null }), { code: 'RUNNER_DISK_FULL' });
  assert.throws(() => assertDiskFree(null), { code: 'RUNNER_DISK_FULL' });
  assert.equal(DEFAULT_MIN_FREE_BYTES, 10 * GIB);
  assert.doesNotThrow(() => assertDiskFree({ freeBytes: 10 * GIB }));
  assert.throws(() => assertDiskFree({ freeBytes: 10 * GIB - 1 }), { code: 'RUNNER_DISK_FULL' });
});

test('runner.floor.gate-diskfloormb-in-the-machine-settings-sets: gate.diskFloorMB in the machine settings sets the floor, and a bad value falls back to 10 GB [C7]', t => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-disk-floor-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(diskFloorBytes(home), 10 * GIB, 'no settings file means the default');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ gate: { diskFloorMB: 2048 } }));
  assert.equal(diskFloorBytes(home), 2 * GIB);
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ gate: { diskFloorMB: 'lots' } }));
  assert.equal(diskFloorBytes(home), 10 * GIB, 'an invalid value never becomes a percentage or a zero floor');
});


test('runner.floor.explicit-machine-home: [C7] supplied home overrides process home and invalid or unreadable settings retain the default', t => {
  const supplied = privateFixtureFiles('pullboard-floor-supplied-').root;
  const processHome = privateFixtureFiles('pullboard-floor-process-').root;
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(supplied, { recursive: true, force: true });
    rmSync(processHome, { recursive: true, force: true });
  });
  assert.notEqual(supplied, processHome);
  process.env.PULLBOARD_MACHINE_HOME = processHome;
  const settings = join(supplied, 'settings.json');
  fixtureMachineSettings(processHome, { gate: { diskFloorMB: 999 } });
  assert.equal(diskFloorBytes(supplied), DEFAULT_MIN_FREE_BYTES, 'missing supplied file never uses process settings');
  assert.equal(diskFloorBytes(), DEFAULT_MIN_FREE_BYTES, 'omitted home never uses process settings');
  for (const invalid of [undefined, null, 42, {}, []]) {
    assert.equal(diskFloorBytes(invalid), DEFAULT_MIN_FREE_BYTES, 'invalid explicit home retains the catch fallback');
  }
  mkdirSync(settings);
  assert.equal(diskFloorBytes(supplied), DEFAULT_MIN_FREE_BYTES, 'a directory cannot be read as the settings file');
  rmSync(settings, { recursive: true });
  writeFileSync(settings, '{broken');
  assert.equal(diskFloorBytes(supplied), DEFAULT_MIN_FREE_BYTES, 'malformed JSON retains the catch fallback');
  for (const value of [0, 1, 2048, Number.MAX_SAFE_INTEGER]) {
    fixtureMachineSettings(supplied, { gate: { diskFloorMB: value } });
    assert.equal(diskFloorBytes(supplied), value * 1024 ** 2, 'safe nonnegative integer MB uses the supplied home');
  }
  for (const value of [-1, 1.5, '2048', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    fixtureMachineSettings(supplied, { gate: { diskFloorMB: value } });
    assert.equal(diskFloorBytes(supplied), DEFAULT_MIN_FREE_BYTES, 'invalid MB retains the default');
  }
  fixtureMachineSettings(supplied, {});
  assert.equal(diskFloorBytes(supplied), DEFAULT_MIN_FREE_BYTES, 'absent gate setting retains the default');
});
