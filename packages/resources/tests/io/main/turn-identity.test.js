/** A write turn confirms a reused PID from a read made before it and never spawns ps [C7,#8497]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmIdentities,
  duringWriteTurn,
  freshIdentity,
  processIdentity,
  refreshIdentitiesAsync,
} from '../../../src/io/identities.js';

const STALE = 'Mon Jan 1 00:00:00 2024';
/** A ps standing in for the real one: it reports this process as started long ago, so any real read replaces it visibly. */
const read = async pids => pids.map(pid => `${pid} ${STALE} S`).join('\n');

test('clause 1: a resource-write turn that finds a cached mismatch keeps the lease and the cache, with no ps read inside the turn [C7,#8497]', async () => {
  await refreshIdentitiesAsync([process.pid], { read });
  const inside = duringWriteTurn(() => freshIdentity(process.pid));
  assert.equal(inside, null, 'an identity not read fresh before the turn is unknown inside it, which keeps the lease');
  assert.equal(processIdentity(process.pid).started, STALE, 'the turn did not replace the cache with a real ps read');
});

test('clause 2: a write turn never spawns ps to confirm an identity; the read made before the turn answers it [C7,#8497]', async () => {
  await refreshIdentitiesAsync([process.pid], { read });
  confirmIdentities([process.pid], pid => processIdentity(pid)?.started === STALE);
  const real = processIdentity(process.pid);
  assert.notEqual(real.started, STALE, 'the pre-turn confirmation read the real identity');
  const inside = duringWriteTurn(() => freshIdentity(process.pid));
  assert.deepEqual(inside, real, 'the turn answers from the pre-turn read');
  assert.deepEqual(processIdentity(process.pid), real, 'the cache is the pre-turn read, so the turn spawned nothing');
});
