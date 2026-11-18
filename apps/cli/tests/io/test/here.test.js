/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin: clause 1 reads here.js itself to prove runHere hands the run id and log path to recordClauseTicks [C7,#10866]. */
/** A green run's record write refused POLICY_SNAPSHOT_STALE is written again against the new main, only with test.retryStaleRecord on [C7,#10663]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { testRunTickNotes } from '../../../../../packages/state/index.js';
import { recordAgainstMain } from '../../../src/io/test/here.js';
import { statusOutcomes } from '../../../src/io/test/status-outcomes.js';

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

test('cli.io-test-here.run-ticks-no-check-clauses: clause 1: runHere hands the queued run id (values test-run) and the green run log path to recordClauseTicks, which reads the log\'s outcome rows into testRunTickNotes, so a no-check item gets one tick per [test] clause its cases prove [C7,#10866]', () => {
  const source = readFileSync(new URL('../../../src/io/test/here.js', import.meta.url), 'utf8');
  assert.match(source, /recordClauseTicks\(io, item, files, \{ run: values\['test-run'\], logPath: result\.logPath \}\)/u);
  const run = '6b1c0f2e-1111-4222-8333-444455556666';
  const frame = (file, name) => `# pullboard test outcomes ${JSON.stringify({ version: 1, id: run, tests: [{ file, name, passed: true, skipped: false }] })}\n`;
  const fixture = privateFixtureFiles('pullboard-here-ticks-');
  const log = join(fixture.root, 'output.log');
  fixture.write('output.log', `ok 1 - padding\n${frame('apps/cli/tests/io/test/here.test.js', 'cli.io-test-here.x: clause 1: a case')}${frame('apps/cli/tests/other.test.js', 'clause 2: wrong file')}`);
  const item = { item_check: '', item_criterion: '1. First, proved by a case in apps/cli/tests/io/test/here.test.js [test]\n2. Second, proved by a case in apps/cli/tests/io/test/here.test.js [test]' };
  const notes = testRunTickNotes(item, ['apps/cli/tests/io/test/here.test.js'], 'a'.repeat(40), { outcomes: statusOutcomes(log), run });
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp(`^clause 1 \\[test\\]: .*run ${run}.*cli\\.io-test-here\\.x`, 'u'));
});
