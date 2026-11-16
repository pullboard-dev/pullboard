/** The scratch-memory warning names the process and size past its limits and stays silent below them [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scratchMemoryFindings } from '../index.js';

const GB = 1024 ** 3;
const now = new Date('2026-11-15T12:00:00Z');

test('clause 1: fseventsd over 4 GB warns, naming the process and its size [C7]', () => {
  const [finding, ...rest] = scratchMemoryFindings({ processes: [{ pid: 321, name: 'fseventsd', bytes: 30 * GB }], now });
  assert.equal(rest.length, 0);
  assert.equal(finding.cause, 'SCRATCH_MEMORY');
  assert.match(finding.title, /fseventsd/u);
  assert.match(finding.title, /30\.0 GB/u);
  assert.match(finding.why, /fseventsd \(pid 321\)/u);
});

test('clause 1: swap over 75 percent warns, naming the size and the largest process [C7]', () => {
  const [finding, ...rest] = scratchMemoryFindings({ processes: [{ pid: 7, name: 'node', bytes: 2 * GB }, { pid: 8, name: 'tiny', bytes: GB }],
    swap: { usedBytes: 37 * GB, totalBytes: 39 * GB }, now });
  assert.equal(rest.length, 0);
  assert.match(finding.title, /95% used/u);
  assert.match(finding.title, /37\.0 GB of 39\.0 GB/u);
  assert.match(finding.why, /largest process node \(pid 7\) holds 2\.0 GB/u);
});

test('clause 2: fseventsd at 4 GB or less and swap at 75 percent or less stay silent [C7]', () => {
  assert.deepEqual(scratchMemoryFindings({ processes: [{ pid: 1, name: 'fseventsd', bytes: 4 * GB }], swap: { usedBytes: 3 * GB, totalBytes: 4 * GB }, now }), []);
  assert.deepEqual(scratchMemoryFindings({ processes: [{ pid: 2, name: 'fseventsd', bytes: GB }], swap: { usedBytes: GB, totalBytes: 4 * GB }, now }), []);
  assert.deepEqual(scratchMemoryFindings({ now }), []);
});

test('clause 2: a large process that is not fseventsd does not warn on its own [C7]', () => {
  assert.deepEqual(scratchMemoryFindings({ processes: [{ pid: 3, name: 'node', bytes: 30 * GB }], now }), []);
});
