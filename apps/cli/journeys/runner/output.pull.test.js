/** A red pulled gate keeps enough output to name its cause: each failing case with its error, the lines that explain its exit, and its full output on the runner [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fitReceipt } from '../../src/logic/runner/output.js';
import { tapCaseErrors } from '../../src/logic/runner/output.js';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { keptOutputFolder } from '../../../../packages/drive/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';

const GATE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;

/** Main's gate door with the real TAP accounting and timing reads, as accepted main carries them. */
const GATE_DOOR = `${TOOLING['packages/gate/index.js']}export { accountedFailures, timingAccountingStages, timingSource, TIMING_RUN_ID_ENV } from ${JSON.stringify(GATE)};\n`;

/** The item's one gate job and its posted receipt. */
function posted(board, id) {
  const job = jobsOf(board.db, { kind: 'gate', item: id })[0];
  return { job, receipt: job.steps.find(step => step.name === 'receipt').payload.receipt };
}

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

/** Three failing cases, each with its own error: a plain throw, a multi-line assertion and a quoted message. */
const CASES = `import assert from 'node:assert/strict';
import { test } from 'node:test';
test('passing case', () => {});
test('throws', () => { throw new Error('fixture db is locked'); });
test('compares', () => { assert.equal(1 + 1, 3); });
test("quotes", () => { throw new Error("can't open 'web/seed.json'"); });
`;

/** Main's proof as the affectedTests runner prints it on a runner: the file's TAP, then the run's phase line. */
const CASES_PROOF = `import { spawnSync } from 'node:child_process';
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'web/cases.test.js'], { env, encoding: 'utf8' });
process.stdout.write(ran.stdout);
process.stderr.write('run-tests: phases selection 0.1s, tests 0.7s, total 0.9s\\n');
process.exitCode = ran.status;
`;

test('clause 1: a red pulled proof\'s receipt names each failing case with its error message [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': CASES_PROOF, 'web/cases.test.js': CASES, 'packages/gate/index.js': GATE_DOOR } });
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const served = await serveOnce(box, url, 'r-cases');
  assert.equal(served.code, 0, served.output);

  const proof = posted(board, id).receipt.gate.phases.find(phase => phase.role === 'proof');
  assert.equal(proof.status, 1, proof.tail);
  assert.deepEqual(proof.errors.map(row => [row.file, row.name]),
    [['web/cases.test.js', 'throws'], ['web/cases.test.js', 'compares'], ['web/cases.test.js', 'quotes']], JSON.stringify(proof.errors));
  const [thrown, compared, quoted] = proof.errors.map(row => row.error);
  assert.equal(thrown, 'fixture db is locked');
  assert.match(compared, /Expected values to be strictly equal:[\s\S]*2 !== 3/u, compared);
  assert.equal(quoted, "can't open 'web/seed.json'");
  assert.equal(proof.errorCount, 3);
  assert.equal(proof.errorsKept, 'proof.errors.json', 'every case is kept whole on the runner');
  // The accounted cases the board compares with main stay as they were: file and name only.
  assert.deepEqual(proof.failures, [{ file: 'web/cases.test.js', name: 'throws' }, { file: 'web/cases.test.js', name: 'compares' }, { file: 'web/cases.test.js', name: 'quotes' }]);
});

/** A proof that crashes before any test reports: noise, the error, then closing counts and a timing frame longer than the receipt's tail. */
const CRASH_PROOF = `for (let n = 0; n < 2000; n++) console.log('setup line ' + n);
console.log('Error: fixture database is locked (SQLITE_BUSY)');
console.log('    at openFixture (web/setup.js:12:9)');
console.log('# tests 0');
console.log('# pass 0');
console.log('# fail 0');
console.log('# pullboard suite timing ' + JSON.stringify({ version: 1, shards: Array.from({ length: 200 }, (_, n) => ({ shard: n + '/200', attempt: 1, wallMs: n })) }));
console.log('run-tests: phases selection 0.1s, tests 0.7s, total 0.9s');
process.exitCode = 7;
`;

test('clause 2: a red pulled gate whose proof names no case records the last lines that explain its exit, and keeps its full output on the runner by job [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': CRASH_PROOF, 'packages/gate/index.js': GATE_DOOR } });
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const served = await serveOnce(box, url, 'r-crash');
  assert.equal(served.code, 0, served.output);

  const { job, receipt } = posted(board, id);
  const proof = receipt.gate.phases.find(phase => phase.role === 'proof');
  assert.deepEqual([proof.status, proof.failures, proof.errors], [7, null, []], JSON.stringify(proof).slice(0, 2000));
  assert.doesNotMatch(proof.tail, /fixture database is locked/u, 'the plain tail ends on the timing frame, so it alone could not name the cause');
  assert.match(proof.exit, /Error: fixture database is locked \(SQLITE_BUSY\)\n {4}at openFixture \(web\/setup\.js:12:9\)$/u, proof.exit);
  assert.doesNotMatch(proof.exit, /# (?:tests|pass|fail) 0|# pullboard suite timing|run-tests: phases/u, proof.exit);
  assert.match(facts(board, id), /proof exited 7: .*Error: fixture database is locked \(SQLITE_BUSY\) at openFixture/u, facts(board, id));

  // The whole output stays on the runner under the job's id, past the checkout's deletion.
  const folder = keptOutputFolder(join(box.runnerHome, 'r-crash'), job.id, 1);
  assert.deepEqual(receipt.output, { runner: 'r-crash', folder });
  assert.equal(proof.kept, 'proof.log');
  const kept = readFileSync(join(folder, 'proof.log'), 'utf8');
  assert.equal(Buffer.byteLength(kept), proof.bytes);
  assert.match(kept, /^setup line 0\n/u);
  assert.match(kept, /Error: fixture database is locked/u);
});

/** A TAP stream with `count` failing cases, each with a long error. */
function manyFailures(count) {
  return Array.from({ length: count }, (_, n) => `not ok ${n + 1} - case ${n}\n  ---\n  location: '/r/web/many.test.js:${n}:1'\n  failureType: 'testCodeFailure'\n  error: 'case ${n} broke: ${'x'.repeat(400)}'\n  ...`).join('\n');
}

test('clause 1: a red proof with hundreds of failures names every case, and a receipt fitted to its cap keeps each name [P7,#5828]', () => {
  const errors = tapCaseErrors(manyFailures(450), '/r');
  assert.equal(errors.length, 450, 'no case cap');
  assert.equal(errors[449].name, 'case 449');
  assert.match(errors[449].error, /^case 449 broke: x+$/u);
  const receipt = fitReceipt({ phases: [{ role: 'proof', status: 1, tail: 't'.repeat(5000), errors }] }, 56 * 1024);
  const [proof] = receipt.phases;
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 56 * 1024);
  assert.deepEqual(proof.errors.map(row => row.name), errors.map(row => row.name), 'every case keeps its row; the errors shrink first');
  assert.equal(proof.errorCount, 450);
  assert.equal(proof.errorsOmitted, undefined);
  assert.match(proof.errors[0].error, /^case 0 broke/u, 'each row keeps the start of its message while it fits');
});

test('clause 1: when the names alone overflow the cap, the receipt counts every case and says how many rows it left to the runner\'s kept list [P7,#5828]', () => {
  const errors = tapCaseErrors(manyFailures(3000), '/r');
  const receipt = fitReceipt({ phases: [{ role: 'proof', status: 1, tail: '', errors, errorsKept: 'proof.errors.json' }] }, 56 * 1024);
  const [proof] = receipt.phases;
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 56 * 1024);
  assert.equal(proof.errorCount, 3000);
  assert.ok(proof.errors.length > 0 && proof.errors.length < 3000);
  assert.equal(proof.errorsOmitted, 3000 - proof.errors.length);
  assert.deepEqual(proof.errors.map(row => row.name), errors.slice(0, proof.errors.length).map(row => row.name), 'the first cases keep their rows, in order');
  assert.equal(proof.errorsKept, 'proof.errors.json');
});
