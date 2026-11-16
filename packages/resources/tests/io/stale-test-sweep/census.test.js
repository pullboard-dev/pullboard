/** @pullboard-test-input source-cell resources */
/** A live `pullboard test --census` process is never stopped by the machine's stale-test sweep, however long its shards run [C7,#8305]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STALE_TEST_AFTER_MS } from '../../../src/io/stale-test-sweep.js';
import { sweepStaleTests } from '../../../src/io/stale-test-sweep.js';

const CENSUS = 'node apps/cli/pullboard.js test --census --wait --no-file-limit --out /Users/person/census/1115-1404-2d7f1e086d.jsonl';

test('clause 1: a live census process past the file budget is never stopped by the sweep [C7]', () => {
  // The 15 Nov 2:04 pm census: its process died about 1,030 s in, and 19 of 36 shards got no rows.
  const drivers = [
    { pid: 3380, ppid: 900, ageMs: 1_030_000, command: CENSUS },
    { pid: 3381, ppid: 1, ageMs: 24 * 3_600_000, command: `/usr/local/bin/${CENSUS}` },
    { pid: 3382, ppid: 900, ageMs: STALE_TEST_AFTER_MS + 1, command: 'node /repo/apps/cli/pullboard.js test --census' },
  ];
  const signalled = [];
  assert.deepEqual(sweepStaleTests({ processes: drivers, own: 7, stop: pid => signalled.push(pid) }), []);
  assert.deepEqual(signalled, [], 'no census process is signalled');
});

test('clause 2: a test process started under a census process is still stopped past the file budget [C7]', () => {
  const child = { pid: 3390, ppid: 3380, ageMs: STALE_TEST_AFTER_MS + 1, command: '/usr/local/bin/node bin/run-tests.js apps/cli/journeys/publish/catalog.test.js' };
  const signalled = [];
  const stopped = sweepStaleTests({ processes: [{ pid: 3380, ppid: 900, ageMs: 1_030_000, command: CENSUS }, child], own: 7, stop: pid => signalled.push(pid) });
  assert.deepEqual(stopped.map(row => row.pid), [3390]);
  assert.deepEqual(signalled, [3390]);
});
