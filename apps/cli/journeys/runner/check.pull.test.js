/** A pulled gate job runs an item check that calls pullboard with main's trusted CLI, and names every failing case of a long red proof [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';

const GATE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;

/** Main's stand-in CLI, executable with Node's env line as the real one: it answers with a marker and its arguments, so the check can tell it from any other pullboard. */
const MAIN_CLI = "#!/usr/bin/env node\nprocess.stdout.write('trusted-main ' + process.argv.slice(2).join('|') + '\\n');\n";

/** The gate job's receipt for an item's one gate job. */
function receiptOf(board, id) {
  return jobsOf(board.db, { kind: 'gate', item: id })[0].steps.find(step => step.name === 'receipt').payload.receipt;
}

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

test('clause 1: inside a pulled gate job an item check that calls pullboard runs main\'s trusted CLI, never exit 127 [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  // The test runner's PATH puts a refusing pullboard first, and a runner daemon's PATH has none: only the job's own CLI passes.
  const check = () => `test "$(pullboard probe 'two words')" = "trusted-main probe|two words"`;
  const box = await pullProject(t, 1, { check });
  mkdirSync(join(box.repo, 'apps/cli'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/pullboard.js'), MAIN_CLI, { mode: 0o755 });
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: main stand-in CLI [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const [id] = box.ids;
  const { commit } = submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const served = await serveOnce(box, url, 'r-cli');
  assert.equal(served.code, 0, served.output);

  const gate = receiptOf(board, id).gate;
  assert.deepEqual(gate.phases.map(phase => [phase.role, phase.status]), [['check', 0], ['proof', 0]], JSON.stringify(gate.phases).slice(0, 4000));
  const item = getItem(board, id);
  assert.deepEqual([item.item_status, item.item_commit], ['submitted', commit], facts(board, id));
});

/** Twenty-five failing cases among passing ones, one of which logs over a megabyte, as a long real proof does. */
const MANY = `import { test } from 'node:test';
test('a loud passing case', () => { for (let n = 0; n < 12_000; n++) console.log('log line ' + n + ' ' + 'x'.repeat(100)); });
for (let n = 1; n <= 25; n++) {
  test('passing case ' + n, () => {});
  test('failing case ' + n, () => { throw new Error('red ' + n); });
}
`;

/** Main's proof as the affectedTests runner prints it on a runner: the file's TAP, then the run's own suite timing frame and phase line. */
const PROOF = `import { spawnSync } from 'node:child_process';
import { formatSuiteTiming } from ${JSON.stringify(GATE)};
import { timingSource } from ${JSON.stringify(GATE)};
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'web/many.test.js'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
process.stdout.write(ran.stdout);
process.stdout.write(formatSuiteTiming({ version: 1, id: process.env.PULLBOARD_TIMING_RUN_ID, ...timingSource(process.cwd()), node: process.versions.node, full: false,
  wallMs: 9, selectionMs: 1, setupMs: 1, shards: [{ shard: '1/1', attempt: 1, wallMs: 7 }], compareMs: null }));
process.stderr.write('run-tests: phases selection 0.1s, tests 0.7s, total 0.9s\\n');
process.exitCode = ran.status;
`;

test('clause 2: a pulled proof with 25 failing cases in over a megabyte of output lists every case by file and name, in its receipt and on the item [P7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  // Main's gate door carries the real TAP accounting and timing reads, as accepted main does.
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': PROOF, 'web/many.test.js': MANY,
    'packages/gate/index.js': `${TOOLING['packages/gate/index.js']}export { accountedFailures, timingAccountingStages, timingSource, TIMING_RUN_ID_ENV } from ${JSON.stringify(GATE)};\n` } });
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  assert.equal((await serveOnce(box, url, 'r-many')).code, 0);

  const proof = receiptOf(board, id).gate.phases.find(phase => phase.role === 'proof');
  assert.ok(proof.bytes > 1024 ** 2, `the proof printed over a megabyte (${proof.bytes} bytes)`);
  const expected = Array.from({ length: 25 }, (_, n) => ({ file: 'web/many.test.js', name: `failing case ${n + 1}` }));
  assert.deepEqual([proof.status, proof.failures], [1, expected], proof.tail);
  const thread = facts(board, id);
  for (const { name } of expected) assert.match(thread, new RegExp(`^proof failed: web/many\\.test\\.js :: ${name}$`, 'mu'), thread);
  assert.doesNotMatch(thread, /proof exited 1/u, 'the red names its cases, never only its output\'s tail');
});
