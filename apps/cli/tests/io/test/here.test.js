/** @pullboard-test-input source-cell apps/cli */
/** A green run's record write refused POLICY_SNAPSHOT_STALE is written again against the new main, only with test.retryStaleRecord on [C7,#10663]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordAgainstMain } from '../../../src/io/test/here.js';

/** A refusal shaped as the board throws it: only its code decides a retry. */
const refusal = code => Object.assign(new Error(`[${code}] refused`), { code });

/** A record write that is refused with the given codes in turn, then returns 'recorded'. */
function writeRefused(codes) {
  const calls = { count: 0 };
  const write = async () => {
    const code = codes[calls.count++];
    if (code) throw refusal(code);
    return 'recorded';
  };
  return { calls, write };
}

test('cli.io-test-here.stale-record-written-again: clause 1: with test.retryStaleRecord on, recordAgainstMain runs a record write again after a POLICY_SNAPSHOT_STALE refusal and returns its result once main holds still (the wrapper runHere puts around its clause-tick and proof writes) [C7]', async () => {
  const { calls, write } = writeRefused(['POLICY_SNAPSHOT_STALE', 'POLICY_SNAPSHOT_STALE']);
  assert.equal(await recordAgainstMain(write, { enabled: true }), 'recorded');
  assert.equal(calls.count, 3);
});

test('cli.io-test-here.stale-record-off-throws: clause 2: with test.retryStaleRecord off (the default) a POLICY_SNAPSHOT_STALE refusal is thrown at once, as today [C7]', async () => {
  const { calls, write } = writeRefused(['POLICY_SNAPSHOT_STALE']);
  await assert.rejects(recordAgainstMain(write, { enabled: false }), { code: 'POLICY_SNAPSHOT_STALE' });
  assert.equal(calls.count, 1);
});

test('cli.io-test-here.stale-record-never-loops: clause 3: any other refusal, and a third stale refusal in a row, is thrown, so a record write never loops [C7]', async () => {
  const other = writeRefused(['BOARD_BUSY']);
  await assert.rejects(recordAgainstMain(other.write, { enabled: true }), { code: 'BOARD_BUSY' });
  assert.equal(other.calls.count, 1);
  const stale = writeRefused(['POLICY_SNAPSHOT_STALE', 'POLICY_SNAPSHOT_STALE', 'POLICY_SNAPSHOT_STALE', 'POLICY_SNAPSHOT_STALE']);
  await assert.rejects(recordAgainstMain(stale.write, { enabled: true }), { code: 'POLICY_SNAPSHOT_STALE' });
  assert.equal(stale.calls.count, 3);
});
