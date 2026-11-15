/** @pullboard-test-input source-cell resources */
/** A live `pullboard test --test-run` worker is never stopped by the machine's stale-test sweep, however long its run waits [C7,#8193]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STALE_TEST_AFTER_MS } from '../../../src/io/stale-test-sweep.js';
import { sweepStaleTests } from '../../../src/io/stale-test-sweep.js';

const DRIVER = '/Users/person/.nvm/versions/node/v22.22.2/bin/node /Users/person/repo/apps/cli/pullboard.js test --test-run d4ac4dc7-e98b-4964-9a9b-ca1927e1804c apps/cli/journeys/publish/catalog.test.js';

test('#8193 clause 2: a live run worker past the file budget is never stopped by the sweep [C7]', () => {
  // The 15 Nov case: worker 99149 waited 1037 s on its runner job and the age rule stopped it.
  const workers = [
    { pid: 99149, ppid: 1, ageMs: 1_037_000, command: DRIVER },
    { pid: 99150, ppid: 1, ageMs: 24 * 3_600_000, command: DRIVER.replace('d4ac4dc7', 'aaaaaaaa') },
    { pid: 99151, ppid: 500, ageMs: STALE_TEST_AFTER_MS + 1, command: DRIVER.replace('d4ac4dc7', 'bbbbbbbb') },
  ];
  const signalled = [];
  assert.deepEqual(sweepStaleTests({ processes: workers, own: 7, stop: pid => signalled.push(pid) }), []);
  assert.deepEqual(signalled, [], 'no run worker is signalled');
});

test('#8193 clause 2: the test processes under a run worker are still stopped past the budget [C7]', () => {
  const child = { pid: 99152, ppid: 99149, ageMs: STALE_TEST_AFTER_MS + 1, command: '/usr/local/bin/node bin/run-tests.js apps/cli/journeys/publish/catalog.test.js' };
  const signalled = [];
  const stopped = sweepStaleTests({ processes: [{ pid: 99149, ppid: 1, ageMs: 1_037_000, command: DRIVER }, child], own: 7, stop: pid => signalled.push(pid) });
  assert.deepEqual(stopped.map(row => row.pid), [99152]);
  assert.deepEqual(signalled, [99152]);
});
