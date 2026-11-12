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
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';
import { criterionMainReceipts } from '../../src/io/submit/receipt.js';

const LIGHT = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/light.js')).href;
const GATE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;
/** A test file whose two cases fail, and one whose only case fails; main's receipts name only "main case" as red. */
const CASES = {
  'web/mixed.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\ntest('new case', () => { throw new Error('new'); });\n",
  'web/main.test.js': "import { test } from 'node:test';\ntest('main case', () => { throw new Error('main'); });\n",
};

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

test('clause 1: a pulled gate marks each failing case new or also failing on main from main\'s receipts, and only new failures return the item [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two submits and two whole gates in runner processes.
async t => {
  // The check runs node --test as its own top-level run, not as a child of this test file's runner.
  const check = n => `env -u NODE_TEST_CONTEXT node --test --test-reporter=tap ${n === 1 ? 'web/mixed.test.js' : 'web/main.test.js'}`;
  const box = await pullProject(t, 2, { check });
  // Main gains the two test files, a test command for its receipts and main's own TAP reader, which the gate job loads from main.
  for (const [path, text] of Object.entries({ ...CASES, 'packages/gate/light.js': `export { tapFailures } from ${JSON.stringify(LIGHT)};\n` })) {
    mkdirSync(dirname(join(box.repo, path)), { recursive: true });
    writeFileSync(join(box.repo, path), text);
  }
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: main red cases [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const main = box.git(box.repo, 'rev-parse', 'main');
  // Main's receipts: each file is red on main in "main case" only.
  const red = file => ({ result: 'red', failures: [{ file, name: 'main case', signature: 'a'.repeat(64) }], signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION, receiptId: `mr-${file}` });
  mkdirSync(dirname(cacheFile(box.repo)), { recursive: true });
  writeFileSync(cacheFile(box.repo), JSON.stringify({ version: 2, entries: { [main]: Object.fromEntries(Object.keys(CASES).map(file => [file, red(file)])) } }), { mode: 0o600 });

  const [mixed, mainOnly] = box.ids;
  const mixedSubmit = submitOne(box, mixed);
  const mainSubmit = submitOne(box, mainOnly);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo, compareWithMain: criterionMainReceipts }) });
  const builder = getItem(board, mixed).item_owner;
  for (const runner of ['r-one', 'r-two']) assert.equal((await serveOnce(box, url, runner)).code, 0);
  const receiptOf = id => jobsOf(board.db, { kind: 'gate', item: id })[0].steps.find(step => step.name === 'receipt').payload.receipt;

  // The receipt names each failing case of the red check phase.
  assert.deepEqual(receiptOf(mixed).gate.phases.find(phase => phase.role === 'check').failures,
    [{ file: 'web/mixed.test.js', name: 'main case' }, { file: 'web/mixed.test.js', name: 'new case' }], JSON.stringify(receiptOf(mixed)).slice(0, 4000));

  const returned = getItem(board, mixed);
  assert.deepEqual([returned.item_status, returned.item_owner], ['claimed', builder], 'a new failure returns the item to its builder');
  const red1 = facts(board, mixed);
  assert.match(red1, new RegExp(`red at ${mixedSubmit.commit.slice(0, 12)}; failing parts:`, 'u'));
  assert.match(red1, /also fails on main: check web\/mixed\.test\.js \(main case\)/u, 'the main red is marked as main\'s');
  assert.match(red1, /new: check web\/mixed\.test\.js \(new case\)/u, 'the new failure is marked new');

  const passed = getItem(board, mainOnly);
  assert.deepEqual([passed.item_status, passed.item_commit], ['submitted', mainSubmit.commit], `a red only in main's cases never bounces the builder: ${facts(board, mainOnly)}`);
  assert.match(facts(board, mainOnly), /only in cases that also fail on main [0-9a-f]{12} \(not this item's; accepted\):\nalso fails on main: check web\/main\.test\.js \(main case\)/u);
});

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

test('clause 2: a pulled proof red only in a case main also fails lists that case and submits the item for review [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, one submit and one whole gate in a runner process.
async t => {
  // Main's gate door carries the real TAP accounting and timing reads beside the stand-in plan, as accepted main does.
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': RUN_TESTS_PROOF, 'web/main.test.js': CASES['web/main.test.js'],
    'packages/gate/index.js': `${TOOLING['packages/gate/index.js']}export { accountedFailures, timingAccountingStages, timingSource, TIMING_RUN_ID_ENV } from ${JSON.stringify(GATE)};\n` } });
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
  assert.equal((await serveOnce(box, url, 'r-one')).code, 0);
  const proof = jobsOf(board.db, { kind: 'gate', item: id })[0].steps.find(step => step.name === 'receipt').payload.receipt.gate.phases.find(phase => phase.role === 'proof');
  assert.match(proof.tail, /# pullboard suite timing [\s\S]*CPU-load test uses|CPU-load test uses[\s\S]*# pullboard suite timing /u, 'the proof printed the runner\'s trailer lines');
  assert.deepEqual([proof.status, proof.failures], [1, [{ file: 'web/main.test.js', name: 'main case' }]], proof.tail);

  const passed = getItem(board, id);
  assert.deepEqual([passed.item_status, passed.item_commit], ['submitted', submitted.commit], `a proof red only in main's case goes to review: ${facts(board, id)}`);
  assert.match(facts(board, id), /only in cases that also fail on main [0-9a-f]{12} \(not this item's; accepted\):\nalso fails on main: proof web\/main\.test\.js \(main case\)/u);
});
