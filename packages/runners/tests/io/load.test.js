/** Runner load samples carry swap used and total only behind the swap flag, off by default [C7,#10583]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMeminfoSwap } from '../../src/io/load.js';
import { parseSwapusage } from '../../src/io/load.js';
import { sampleRunnerLoad } from '../../src/io/load.js';

const SWAPUSAGE = 'total = 5120.00M  used = 3600.44M  free = 1519.56M  (encrypted)\n';
const MEMINFO = 'MemTotal:       16384000 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n';

test('runners.io-load.with-swap-on-samplerunnerload-adds-swapusedmb: clause 1: sampleRunnerLoad with swap on and an injected reader adds swapUsedMB and swapTotalMB to the sample [C7,#10583]', () => {
  const sample = sampleRunnerLoad({ swap: true, readSwap: () => ({ swapUsedMB: 3600, swapTotalMB: 5120 }) });
  assert.equal(sample.swapUsedMB, 3600);
  assert.equal(sample.swapTotalMB, 5120);
  assert.equal(typeof sample.cpus, 'number');
  assert.equal(sample.average.length, 3);
});

test('runners.io-load.swap-parsers-read-macos-and-linux-text: clause 1: the macOS vm.swapusage and Linux /proc/meminfo parsers give used and total MB, and null for text without swap [C7,#10583]', () => {
  assert.deepEqual(parseSwapusage(SWAPUSAGE), { swapUsedMB: 3600, swapTotalMB: 5120 });
  assert.deepEqual(parseMeminfoSwap(MEMINFO), { swapUsedMB: 1024, swapTotalMB: 2048 });
  assert.equal(parseSwapusage('nothing here'), null);
  assert.equal(parseMeminfoSwap('MemTotal: 1 kB\n'), null);
});

test('runners.io-load.with-swap-off-or-unset-no-swap-read: clause 1: with swap off or unset the sample has no swap fields and the reader is never called [C7,#10583]', () => {
  const readSwap = () => { throw new Error('swap must not be read'); };
  for (const sample of [sampleRunnerLoad({ readSwap }), sampleRunnerLoad({ swap: false, readSwap })]) {
    assert.deepEqual(Object.keys(sample).sort(), ['at', 'average', 'cpus', 'freeMB']);
  }
  assert.equal(sampleRunnerLoad({ swap: true, readSwap: () => null }).swapUsedMB, null);
});
