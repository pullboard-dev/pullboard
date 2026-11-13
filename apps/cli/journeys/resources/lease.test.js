/** @pullboard-test-input apps/cli/pullboard.js */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** A queued review, submit-era check and owned check keep their item lease in the resource pool; split from main.test.js for its file budget [C7,V4]. */
import { after } from 'node:test';
import { test } from 'node:test';
import { queuedLeaseProof } from '../../../../packages/gate/tests/fixtures/resources/lease.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { CHILDREN } from '../../tests/fixtures/resources/pool.js';
import { acquired } from '../../tests/fixtures/resources/pool.js';
import { fixture } from '../../tests/fixtures/resources/pool.js';
import { poolWorker } from '../../tests/fixtures/resources/pool.js';
import { privateList } from '../../tests/fixtures/resources/pool.js';
import { privateTake } from '../../tests/fixtures/resources/pool.js';
import { release } from '../../tests/fixtures/resources/pool.js';
import { waitUntil } from '../../tests/fixtures/resources/pool.js';

const LEASE_HELPERS = createE2eHelpers();
after(() => LEASE_HELPERS.cleanup());

test('a review waiting in the pool keeps its lease [C7,V4]', {
  timeout: 120_000, // budget: real private Git/CLI setup and causally controlled queue/run/death phases, never a production lease extension.
}, (t) => queuedLeaseProof(t, { helpers: LEASE_HELPERS, children: CHILDREN, fixture, poolWorker, privateList, privateTake, acquired, release, waitUntil }));
