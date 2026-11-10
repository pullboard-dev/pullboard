/** Runner recovery skips a round on a locked slot database instead of ending the landing worker [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverUnavailableRunners } from '../../src/io/recovery.js';

/** A slot database whose one due unavailable runner cannot be claimed because the file is locked. */
function lockedDb(message) {
  const row = { host: 'runner-1', since: 1, failure: '{}', probe_after: 0, probe_until: 0 };
  return { prepare: sql => ({
    all: () => (/SELECT \* FROM runner_unavailable/u.test(sql) ? [row] : []),
    run: () => { throw new Error(message); },
  }) };
}

test('a locked slot database skips this recovery round and never throws [C7]', async () => {
  let probed = 0;
  const result = await recoverUnavailableRunners(lockedDb('database is locked'), [{ host: 'runner-1' }], { probe: async () => { probed += 1; return { healthy: true }; }, now: 10 });
  assert.equal(probed, 0, 'no probe runs for a runner the round could not claim');
  assert.notEqual(result, undefined);
});

test('any other database error still surfaces [C7]', async () => {
  await assert.rejects(recoverUnavailableRunners(lockedDb('no such table: runner_unavailable'), [{ host: 'runner-1' }], { probe: async () => ({ healthy: true }), now: 10 }), /no such table/u);
});
