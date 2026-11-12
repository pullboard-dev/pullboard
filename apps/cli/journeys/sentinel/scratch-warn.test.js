/** The sentinel warns by name and size when fseventsd passes 4 GB or swap passes 75 percent, and is silent under both [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { parseProcesses } from '../../../../packages/sentinels/index.js';
import { parseSwap } from '../../../../packages/sentinels/index.js';
import { readScratchMemory } from '../../../../packages/sentinels/index.js';
import { scanHealthSentinel } from '../../../../packages/sentinels/index.js';
import { fixture } from '../../tests/fixtures/next/take.js';

const GB = 1024 ** 3;
const reading = (fseventsd, swapUsed) => () => ({
  processes: [{ pid: 51, name: 'fseventsd', bytes: fseventsd }, { pid: 77, name: 'node', bytes: 2 * GB }],
  swap: { totalBytes: 39 * GB, usedBytes: swapUsed },
});
/** The scratch-memory findings of one real scan of the fixture board, recorded when they changed. */
function observe(box, memory) {
  const observation = scanHealthSentinel(box.file, { root: box.root, config: box.config, now: box.clock.now(), cpu: () => [], tooling: () => [], memory });
  if (observation) store.recordHealthFindings(box.board, { agentId: 'coordinator', ...observation });
  return (observation?.findings ?? []).filter(finding => finding.cause === 'SCRATCH_MEMORY');
}
const notices = box => store.allShouts(box.board).filter(row => row.shout_text.includes('SCRATCH_MEMORY'));

test('clause 1: fseventsd over 4 GB warns by name and size [C7]', async t => {
  const box = await fixture(t);
  const found = observe(box, reading(30 * GB, 1 * GB));
  assert.equal(found.length, 1);
  assert.match(found[0].title, /fseventsd holds 30\.0 GB/u);
  assert.match(found[0].why, /fseventsd \(pid 51\) holds 30\.0 GB/u);
  assert.ok(notices(box).some(row => row.shout_text.includes('fseventsd holds 30.0 GB')), 'the coordinator is told');
});

test('clause 1: swap over 75 percent warns, naming the largest process and its size [C7]', async t => {
  const box = await fixture(t);
  const found = observe(box, reading(1 * GB, 37 * GB));
  assert.equal(found.length, 1);
  assert.match(found[0].title, /swap is 95% used/u);
  assert.match(found[0].why, /largest process node \(pid 77\) holds 2\.0 GB/u);
});

test('clause 1: one episode is announced once across scans [C7]', async t => {
  const box = await fixture(t);
  observe(box, reading(30 * GB, 1 * GB));
  const before = notices(box).length;
  observe(box, reading(31 * GB, 1 * GB));
  assert.equal(notices(box).length, before);
});

test('clause 2: under both limits no finding is emitted [C7]', async t => {
  const box = await fixture(t);
  assert.deepEqual(observe(box, reading(4 * GB, 29 * GB)), []);
  assert.deepEqual(observe(box, () => null), []);
  assert.equal(notices(box).length, 0);
});

test('clause 1: the native reading parses ps and swap output and fails quiet [C7]', () => {
  assert.deepEqual(parseProcesses('  51 31457280 /System/Library/fseventsd\n bad\n'), [{ pid: 51, bytes: 31457280 * 1024, name: 'fseventsd' }]);
  assert.deepEqual(parseSwap('total = 39936.00M  used = 37000.00M  free = 2936.00M  (encrypted)'), { totalBytes: 39936 * 1024 ** 2, usedBytes: 37000 * 1024 ** 2 });
  assert.deepEqual(parseSwap('SwapTotal: 1000 kB\nSwapFree: 250 kB\n'), { totalBytes: 1024000, usedBytes: 768000 });
  assert.equal(readScratchMemory({ run: () => { throw new Error('no ps'); } }), null);
});
