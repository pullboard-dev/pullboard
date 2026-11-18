/** Runner load samples carry disk busy and I/O wait only behind the sample-disk-io setting, off by default [C7,#9029]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { diskSample } from '../../src/io/load.js';
import { parseIoreg } from '../../src/io/load.js';
import { parseProc } from '../../src/io/load.js';
import { sampleRunnerLoad } from '../../src/io/load.js';

const DISKSTATS = '   8       0 sda 100 0 800 50 200 0 1600 90 0 40 140 0 0 0 0\n   8       1 sda1 1 0 8 1 1 0 8 1 0 999 2 0 0 0 0\n';
const STAT = 'cpu  100 0 100 700 100 0 0 0 0 0\n';

test('runners.load-disk.with-the-setting-on-samplerunnerload-returns: clause 1: with the setting on, sampleRunnerLoad returns disk busy % and I/O wait % beside load and cpus [C7,#9029]', () => {
  const reads = [{ busyMs: 1000, cpuTotal: 1000, cpuWait: 100 }, { busyMs: 1600, cpuTotal: 1400, cpuWait: 140 }];
  const clock = [10_000, 11_000];
  const read = () => reads.shift(), now = () => clock.shift();
  const first = sampleRunnerLoad({ diskIo: true, read, now });
  assert.deepEqual([first.diskBusyPct, first.ioWaitPct], [null, null], 'the first sample has no earlier one to compare with');
  const second = sampleRunnerLoad({ diskIo: true, read, now });
  assert.equal(second.diskBusyPct, 60);
  assert.equal(second.ioWaitPct, 10);
  assert.equal(typeof second.cpus, 'number');
  assert.equal(second.average.length, 3);
});

test('runners.load-disk.macos-ioreg-statistics-and-linux-proc: clause 1: macOS ioreg statistics and Linux /proc counters both parse to busy ms, and macOS has no iowait [C7,#9029]', () => {
  const mac = parseIoreg('x "Statistics" = {"Total Time (Read)"=2000000,"Total Time (Write)"=1000000,"Operations (Read)"=5}\n');
  assert.deepEqual(mac, { busyMs: 3, cpuTotal: null, cpuWait: null });
  assert.equal(parseIoreg('nothing here'), null);
  assert.deepEqual(parseProc(DISKSTATS, STAT), { busyMs: 40, cpuTotal: 1000, cpuWait: 100 });
  const reads = [{ busyMs: 0, cpuTotal: null, cpuWait: null }, { busyMs: 500, cpuTotal: null, cpuWait: null }];
  const clock = [1, 1001];
  const sampled = [diskSample(() => reads.shift(), () => clock.shift()), diskSample(() => reads.shift(), () => clock.shift())];
  assert.deepEqual(sampled[1], { busyPct: 50, ioWaitPct: null });
});

/** Runs fn with a private machine home holding these settings, restoring the home afterwards. */
function withSettings(settings, fn) {
  const home = join(privateFixtureFiles('pullboard-load-disk-').root, 'machine-home');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { mkdirSync(home, { recursive: true }); fixtureMachineSettings(home, settings); return fn(); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('runners.load-disk.with-the-setting-off-or-unset: clause 2: with the setting off or unset, the sample is exactly the four load fields and no disk read happens [C7,#9029]', () => {
  const read = () => assert.fail('a default sample must not read the disk');
  for (const settings of [{}, { gate: { sampleDiskIo: false } }]) {
    for (const options of [undefined, {}, { diskIo: false }, { read }]) {
      assert.deepEqual(Object.keys(withSettings(settings, () => sampleRunnerLoad(options))).sort(), ['at', 'average', 'cpus', 'freeMB']);
    }
  }
});
