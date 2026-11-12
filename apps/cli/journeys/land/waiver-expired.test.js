/** Under pull, a person's live waiver still covers the submit gate and the landing job; an expired one covers nothing [B3,R3,P7,#655]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobQueueCall } from '../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../packages/api/index.js';
import { phaseLedger } from '../../../../packages/gate/index.js';
import { planTestActions } from '../../../../packages/gate/index.js';
import { git } from '../../../../packages/git/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { takeLandingJob } from '../../../../packages/landing/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { recordLandingWaiver } from '../../../../packages/store/index.js';
import { recordTestResults } from '../../../../packages/store/index.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { TOOLING } from '../../tests/fixtures/pull.js';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';

const GATE = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;
const WAIVED = 'web/waived.test.js';
const PAST = { now: () => new Date('2000-01-01T00:00:00Z') };
const AS = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'core.hooksPath=/dev/null'];
const INHERITED = /^PULLBOARD_(TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)|LEDGER_HITS)$/u;

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

/** Main's proof as a runner prints it: the TAP of the proof folder's tests (the waived file, whose one case always fails). */
const PROOF = `import { spawnSync } from 'node:child_process';
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
const ran = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: process.argv[2], env, encoding: 'utf8' });
process.stdout.write(ran.stdout);
process.exitCode = ran.status;
`;

test('clause 1: a pulled gate receipt red only in a test the person waived submits waived, not green; an expired waiver leaves it red [B3,R3,P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two submits and two whole gates in runner processes.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'bin/proof.js': PROOF,
    [WAIVED]: "import { test } from 'node:test';\ntest('waived case', () => { throw new Error('waived'); });\n",
    'packages/gate/index.js': `${TOOLING['packages/gate/index.js']}export { accountedFailures, timingAccountingStages, timingSource, TIMING_RUN_ID_ENV } from ${JSON.stringify(GATE)};\n` } });
  const [id] = box.ids;
  // Only an expired waiver names the red test: it covers nothing.
  onBoard(box, board => recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-gate', test: WAIVED, until: '2000-01-02', reason: 'expired fixture exception' }), PAST);
  const first = submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const builder = getItem(board, id).item_owner;
  assert.equal((await serveOnce(box, url, 'r-one')).code, 0);
  const proof = jobsOf(board.db, { kind: 'gate', item: id })[0].steps.find(step => step.name === 'receipt').payload.receipt.gate.phases.find(phase => phase.role === 'proof');
  assert.deepEqual([proof.status, proof.failures], [1, [{ file: WAIVED, name: 'waived case' }]], proof.tail);
  assert.deepEqual([getItem(board, id).item_status, getItem(board, id).item_owner], ['claimed', builder], `an expired waiver leaves the red with its builder: ${facts(board, id)}`);
  assert.match(facts(board, id), new RegExp(`red at ${first.commit.slice(0, 12)}; failing parts:`, 'u'));
  assert.doesNotMatch(facts(board, id), /waived, not green/u);

  // The person waives the file from their terminal; the next gate's identical red is submitted waived, not green.
  const waived = await box.runLocal(box.repo, 'land', '--waive', WAIVED, '--until', '2099-01-01', '--reason', 'private fixture exception', '--json');
  assert.equal(waived.code, 0, waived.err + waived.out);
  const waiver = JSON.parse(waived.out).waiver;
  assert.equal(waiver.by, 'person');
  const second = submitOne(box, id, { path: `web/${id}-again.txt`, body: 'again\n', subject: `feat(web): pulled gate ${id} again [G1]` });
  assert.equal((await serveOnce(box, url, 'r-two')).code, 0);
  const item = getItem(board, id);
  assert.deepEqual([item.item_status, item.item_commit], ['submitted', second.commit], `a red only in the waived test goes to review: ${facts(board, id)}`);
  assert.match(facts(board, id), new RegExp(`at ${second.commit.slice(0, 12)} was red and is recorded as waived, not green; every failure is covered by a live person waiver:\\nwaived: proof waived case \\(web/waived\\.test\\.js\\) by person waiver ${waiver.id} for file web/waived\\.test\\.js: private fixture exception; expires 2099-01-01T00:00:00\\.000Z`, 'u'));
});

// The landing proof's runner plans with the ledger hits and runs only the misses, printing TAP, as run-tests does.
const RUNNER = `import { spawnSync } from 'node:child_process';
import { planTestActions } from ${JSON.stringify(GATE)};
const files = process.argv.slice(2);
const plan = await planTestActions(process.cwd(), files, { fullSuite: false, landing: true, listFiles: () => files });
const { NODE_TEST_CONTEXT, ...env } = process.env;
if (!plan.done) process.exitCode = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...plan.args], { stdio: 'inherit', env }).status ?? 1;
`;

/** A bare trunk remote and a checkout whose item breaks test/b.test.js, with both tests' gate rows on the board ledger. */
async function redItem(t, board) {
  const { root } = privateFixtureFiles('pullboard-land-waiver-');
  const graph = fixtureCommittedGraph('pullboard-land-waiver-dev-');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const dev = graph.root;
  const put = (file, text) => { mkdirSync(dirname(join(dev, file)), { recursive: true }); writeFileSync(join(dev, file), text); git(dev, ['add', file]); };
  const commit = message => { git(dev, [...AS, 'commit', '-q', '-m', message]); return git(dev, ['rev-parse', 'HEAD']); };
  put('package.json', '{ "type": "module" }\n');
  put('bin/proof.mjs', RUNNER);
  put('src/a.js', 'export const a = 1;\n');
  put('src/b.js', 'export const b = 2;\n');
  put('test/a.test.js', "import { test } from 'node:test';\nimport { a } from '../src/a.js';\ntest('a', () => { if (a !== 1) throw new Error('a'); });\n");
  put('test/b.test.js', "import { test } from 'node:test';\nimport { b } from '../src/b.js';\ntest('b', () => { if (b !== 2) throw new Error('b'); });\n");
  const seed = commit('chore: seed');
  const remote = join(root, 'trunk.git');
  git(root, ['clone', '-q', '--bare', dev, remote]);
  git(dev, ['remote', 'add', 'origin', remote]);
  put('src/b.js', 'export const b = 4;\n');
  const item = commit('feat(core): item breaks b [P7]');
  git(dev, ['push', '-q', 'origin', `${item}:refs/heads/item/1`]);
  // The item's gate run, recorded as a posted gate receipt writes its ledger rows; b's row is its own fail.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name))), PULLBOARD_TEST_REUSE: 'record', PULLBOARD_TEST_RESULT_STORE: join(root, 'gate-store') };
  const files = ['./test/a.test.js', './test/b.test.js'], written = [];
  await planTestActions(dev, files, { fullSuite: false, listFiles: () => files, env, write: text => written.push(text) });
  const ledger = phaseLedger(written.join(''), { status: 0 });
  const rows = ledger.files.map(([file, inputKey, context, status]) => ({ file, inputKey, command: 'proof', context: ledger.contexts[context], status: file === 'test/b.test.js' ? 'fail' : status }));
  assert.equal(recordTestResults(board.db, { receipt: `gate:${item.slice(0, 8)}#0`, origin: 'pulled:r-gate', commit: item, rows }), 2);
  return { root, remote, seed, entry: { id: 1, commit: item, ref: 'refs/heads/item/1' } };
}

test('clause 2: the runner land job lands a proof red only in a test the person waived, and holds it while the waiver has expired [B3,R3,P7]', { timeout: 120_000 }, async t => {
  let at = null;
  const board = cellBoard(t, ':memory:', { now: () => at ?? new Date() });
  const box = await redItem(t, board);
  const land = name => {
    offerLandingJob(board.db, { items: [box.entry], expect: box.seed, config: { trunk: { remote: box.remote }, affectedTests: 'node bin/proof.mjs' } });
    return takeLandingJob({ call: body => jobQueueCall(board.db, body, { mode: 'pull' }), runner: name, workdir: join(box.root, 'runners', name) });
  };
  at = PAST.now();
  recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-land', test: 'test/b.test.js', until: '2000-01-02', reason: 'expired fixture exception' });
  at = null;
  const held = await land('r-expired');
  assert.equal(held.receipt.outcome, 'red', `an expired waiver covers nothing: ${JSON.stringify(held.receipt)}`);
  assert.equal(held.receipt.waived, undefined);
  assert.equal(git(box.root, ['--git-dir', box.remote, 'rev-parse', 'refs/heads/main']), box.seed, 'the held landing pushed nothing');

  const waiver = recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'live-land', test: 'test/b.test.js', until: '2099-01-01', reason: 'private fixture exception' });
  const landed = await land('r-live');
  assert.equal(landed.receipt.outcome, 'landed', `a live waiver covers the proof's only red: ${JSON.stringify(landed.receipt)}`);
  assert.deepEqual(landed.receipt.waived, [{ file: 'test/b.test.js', name: 'b', waiver: waiver.id }], 'the receipt names the waived test and its waiver');
  assert.equal(git(box.root, ['--git-dir', box.remote, 'rev-parse', 'refs/heads/main']), landed.receipt.trunk, 'trunk holds the waived landing');
});
