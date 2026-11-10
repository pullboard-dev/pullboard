/** A busy board or locked slot database is waited out, never counted toward GATE_INFRA_EXHAUSTED [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitUntilSettled } from '../../../../index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';

const settle = (run, extra = {}) => {
  const waits = [];
  return submitUntilSettled(run, { healthy: async () => true, wait: async ms => { waits.push(ms); }, say: () => {}, ...extra })
    .then(out => ({ ...out, waits }), error => Object.assign(error, { waits }));
};

test('clause 1: many BOARD_BUSY, DATABASE_LOCKED and SLOT_DB_LOCKED answers wait and then go green, counting no attempt [C7]', async () => {
  const codes = ['BOARD_BUSY', 'BOARD_BUSY', 'DATABASE_LOCKED', 'SLOT_DB_LOCKED', 'BOARD_BUSY', 'BOARD_BUSY'];
  const pinned = [];
  const out = await settle(async () => {
    pinned.push('candidate-abc');
    const code = codes[pinned.length - 1];
    if (code === 'DATABASE_LOCKED') throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    if (code) throw new Refused(code, 'fixture busy');
    return 'GREEN';
  });
  assert.equal(out.result, 'GREEN');
  assert.equal(pinned.length, 7, 'six busy answers, then the run');
  assert.deepEqual([...new Set(pinned)], ['candidate-abc'], 'every retry ran the same pinned candidate');
  assert.deepEqual(out.attempts, [], 'no infrastructure attempt was counted');
});

test('clause 2: only a runner or gate failure counts toward GATE_INFRA_EXHAUSTED, even after busy waits [C7]', async () => {
  let calls = 0;
  const out = await settle(async () => {
    calls += 1;
    if (calls <= 5) throw new Refused('BOARD_BUSY', 'fixture busy');
    throw new Refused('RUNNER_UNAVAILABLE', 'fixture runner down');
  });
  assert.equal(out.code, 'GATE_INFRA_EXHAUSTED');
  assert.deepEqual(out.attempts.map(row => row.code), Array(4).fill('RUNNER_UNAVAILABLE'), 'busy answers are not among the counted attempts');
});

test('clause 3: busy waits back off and are recorded with each code and duration [C7]', async () => {
  let calls = 0;
  const out = await settle(async () => { calls += 1; if (calls <= 3) throw new Refused(calls === 2 ? 'SLOT_DB_LOCKED' : 'BOARD_BUSY', 'busy'); return 'GREEN'; });
  assert.deepEqual(out.waits, [1000, 2000, 4000]);
  assert.deepEqual(out.lockWaits, { count: 3, totalMs: 7000, codes: { BOARD_BUSY: 2, SLOT_DB_LOCKED: 1 } });
  assert.deepEqual(out.attempts, [], 'busy answers do not become infrastructure attempts');
});
