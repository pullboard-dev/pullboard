/** A main-test job names the cases a red file fails on main, and a red it cannot read keys no receipt [C7,P7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { mainRedLookup } from '../../../drive/index.js';
import { MAIN_TEST_JOB } from '../../../drive/index.js';
import { formatTestOutcomes } from '../../../gate/index.js';
import { judgeMainOwnedReds } from '../../../gate/src/io/main/verdict.js';
import { returnedMainReceipts } from '../../../gate/src/io/main/verdict.js';
import * as jobs from '../../../jobs/index.js';
import { applyMainTestReceipt } from '../../src/io/recheck.js';
import { MAIN_TEST_ENTRY } from '../../src/io/recheck.js';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const id = '12345678-1234-1234-1234-123456789abc';
const file = 'tests/red.test.js';
const command = 'node --test';
const tap = `TAP version 13\nnot ok 1 - main fails\n  ---\n  location: '${root}/${file}:3:1'\n  ...\nok 2 - main passes\n1..2\n# tests 2\n# pass 1\n# fail 1\n`;
const rows = [{ file, name: 'main fails', passed: false, skipped: false, failure: 'assertion' }, { file, name: 'main passes', passed: true, skipped: false }];

/** Run the job's entry in the repository against a command that prints `output` and exits 1; return its verdict line, parsed. */
function entryVerdict(output) {
  const encoded = Buffer.from(output).toString('base64');
  const emit = `node -e "process.stdout.write(Buffer.from('${encoded}', 'base64').toString()); process.exitCode = 1"`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync('node', ['--input-type=module', '-e', MAIN_TEST_ENTRY, emit, file], { cwd: root, env, encoding: 'utf8' });
  const line = ran.stdout.split('\n').findLast(row => row.startsWith('PULLBOARD_MAIN_TEST '));
  return { line, verdict: JSON.parse(line.slice('PULLBOARD_MAIN_TEST '.length)), tail: ran.stdout };
}

/** A queued main-test job on a fresh in-memory board, and the board. */
function queued(t, tree) {
  const { db } = fixtureBoard(t);
  const job = mainRedLookup(db, [], { tree, file, command, now: 1000 }).job;
  return { board: { db, gitRoot: null }, job };
}

test('clause 1: a red file whose run printed native outcome frames is named by its failing cases in the receipt line [C7,P7]', () => {
  const { verdict } = entryVerdict(tap + formatTestOutcomes(id, rows));
  assert.equal(verdict.green, false);
  assert.deepEqual(verdict.failing, ['main fails']);
  assert.equal(verdict.signatures.length, 1);
});

test('clause 2: a red whose cases cannot be read records no receipt, so a gate never reads it as naming none [C7,P7]', t => {
  const frames = formatTestOutcomes(id, rows).replace('"version":1', '"version":2');
  const { verdict, tail } = entryVerdict(tap + frames);
  assert.equal(verdict.failing, null, 'unreadable cases are null, never an empty list');
  const { board, job } = queued(t, 'e'.repeat(40));
  const result = applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  assert.deepEqual({ applied: result.applied, outcome: result.outcome }, { applied: false, outcome: 'unnamed' });
  assert.deepEqual(returnedMainReceipts(jobs, board.db, MAIN_TEST_JOB), []);
});

test('clause 3: a gate red only on a case main also fails passes as main-owned from the receipt the job recorded [C7,P7]', t => {
  const tree = 'e'.repeat(40);
  const { tail } = entryVerdict(tap + formatTestOutcomes(id, rows));
  const { board, job } = queued(t, tree);
  const result = applyMainTestReceipt(board, { job, receipt: { tail, commit: 'c'.repeat(40) } }, { now: 2000 });
  assert.equal(result.verdict, 'red');
  const receipts = returnedMainReceipts(jobs, board.db, MAIN_TEST_JOB);
  assert.deepEqual(receipts[0].failing, ['main fails']);
  const base = { commit: 'c'.repeat(40), tree, at: 1000 };
  const same = judgeMainOwnedReds({ base, command, reds: [{ file, name: 'main fails' }], receipts });
  assert.equal(same.verdict, 'green');
  assert.equal(same.mainOwned.length, 1);
  const other = judgeMainOwnedReds({ base, command, reds: [{ file, name: 'main fails' }, { file, name: 'new case' }], receipts });
  assert.equal(other.verdict, 'red', 'a case main does not fail stays the candidate\'s own');
});
