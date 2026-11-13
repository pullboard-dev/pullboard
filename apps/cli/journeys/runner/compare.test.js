/** A pulled gate compares its failing cases with main's receipts: only new failures return the item to its builder [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { cacheFile } from '../../../../packages/landing/index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../../packages/landing/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';
import { criterionMainReceipts } from '../../src/io/submit/receipt.js';
import { CASES } from '../../tests/fixtures/runner/compare.js';
import { facts } from '../../tests/fixtures/runner/compare.js';

const GATE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;

/** Main's stand-in selection with the proof under bin/tests/, since the proof's text names a test file the no-runtime-assumptions preflight refuses elsewhere. */
const PROOF_DOOR = TOOLING['packages/gate/index.js'].replace("proofCommand: 'node bin/proof.js ./web'", "proofCommand: 'node bin/tests/proof.js ./web'");

/**
 * Main's proof as the affectedTests runner prints it on a runner: Node's warning and the no-runner CPU-load line on
 * stderr, the selected file's TAP on stdout, then the run's own suite timing frame and the runner's phase line.
 */
const RUN_TESTS_PROOF = `import { spawnSync } from 'node:child_process';
import { formatSuiteTiming } from ${JSON.stringify(GATE)};
import { timingSource } from ${JSON.stringify(GATE)};
process.stderr.write('(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\\n(Use \`node --trace-warnings ...\` to show where the warning was created)\\n');
process.stderr.write('CPU-load test uses the current admitted slot because no runners are registered\\n');
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'web/main.test.js'], { env, encoding: 'utf8' });
process.stdout.write(ran.stdout);
process.stdout.write(formatSuiteTiming({ version: 1, id: process.env.PULLBOARD_TIMING_RUN_ID, ...timingSource(process.cwd()), node: process.versions.node, full: false,
  wallMs: 9, selectionMs: 1, setupMs: 1, shards: [{ shard: '1/1', attempt: 1, wallMs: 7 }], compareMs: null }));
process.stderr.write('run-tests: phases selection 0.1s, tests 0.7s, total 0.9s\\n');
process.exitCode = ran.status;
`;

test('clause 2: a pulled proof red only in a case main also fails lists that case and submits the item for review [P7]', { timeout: 100_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  // Main's gate door carries the real TAP accounting and timing reads beside the stand-in plan, as accepted main does.
  const box = await pullProject(t, 1, { tooling: { 'bin/tests/proof.js': RUN_TESTS_PROOF, 'web/main.test.js': CASES['web/main.test.js'],
    'packages/gate/index.js': `${PROOF_DOOR}export { accountedFailures, timingAccountingStages, timingSource, TIMING_RUN_ID_ENV } from ${JSON.stringify(GATE)};\n` } });
  // Main's test command keys its receipts.
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: main test command [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const main = box.git(box.repo, 'rev-parse', 'main');
  mkdirSync(dirname(cacheFile(box.repo)), { recursive: true });
  writeFileSync(cacheFile(box.repo), JSON.stringify({ version: 2, entries: { [main]: { 'web/main.test.js': { result: 'red', signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION,
    failures: [{ file: 'web/main.test.js', name: 'main case', signature: 'a'.repeat(64) }], receiptId: 'mr-main' } } } }), { mode: 0o600 });
  const [id] = box.ids;
  const submitted = submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo, compareWithMain: criterionMainReceipts }) });
  const served = await serveOnce(box, url, 'r-one', {}, { deadlineMs: 20_000 });
  assert.equal(served.code, 0, served.output.slice(-3000) + JSON.stringify(jobsOf(board.db, { item: id }).map(j => [j.kind, j.status, j.steps?.map(x => x.name)])));
  const proof = jobsOf(board.db, { kind: 'gate', item: id })[0].steps.find(step => step.name === 'receipt').payload.receipt.gate.phases.find(phase => phase.role === 'proof');
  assert.match(proof.tail, /# pullboard suite timing [\s\S]*CPU-load test uses|CPU-load test uses[\s\S]*# pullboard suite timing /u, 'the proof printed the runner\'s trailer lines');
  assert.deepEqual([proof.status, proof.failures], [1, [{ file: 'web/main.test.js', name: 'main case' }]], proof.tail);

  const passed = getItem(board, id);
  assert.deepEqual([passed.item_status, passed.item_commit], ['submitted', submitted.commit], `a proof red only in main's case goes to review: ${facts(board, id)}`);
  assert.match(facts(board, id), /only in cases that also fail on main [0-9a-f]{12} \(not this item's; accepted\):\nalso fails on main: proof web\/main\.test\.js \(main case\)/u);
});
