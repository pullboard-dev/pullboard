/** @pullboard-test-input apps/lib/src/io/landing/candidate.js */
/**
 * Landing applies the main-owned rule (#3534): a submit recorded green with its only reds owned by main is reused at
 * landing, and a landing gate red only in cases red at its main lands while a case green on main still fails it [C7,#3685].
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  openBoardReadOnly,
  handoffRecord,
} from '../../../../../packages/store/index.js';
import * as jobs from '../../../../../packages/jobs/index.js';
import { GATE_VERDICT_KIND } from '../../../../../packages/gate/index.js';
import { landingReceiptReuse } from '../../../../../packages/landing/index.js';

const MAIN_RED = 'web/main-red.test.js';
const MAIN_RED_CASE = 'main red case [G1]';

/** One node:test file whose cases are named; `red` names the cases that fail. */
function testFile(cases, red = []) {
  return ["import assert from 'node:assert/strict';", "import { test } from 'node:test';",
    ...cases.map(name => `test(${JSON.stringify(name)}, () => assert.equal(1, ${red.includes(name) ? 2 : 1}));`)].join('\n') + '\n';
}

/**
 * A real repository with a bare origin, per-item separate-publish landing and queued submits, whose main already fails
 * one named case in web/main-red.test.js and holds its open Main red repair; plus one item whose frozen check runs that file.
 */
function mainRedLandingProject(helpers) {
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.submit = { ...config.submit, handoff: true };
  config.affectedTests = 'node web/runner.js';
  config.landing = { ...(config.landing ?? {}), perItem: true, manualOverride: true, publish: 'separate', splitRed: false };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/runner.js'), [
    "import { spawnSync } from 'node:child_process';",
    'const files = process.argv.slice(2);',
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', env: process.env });",
    "process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');",
    'process.exitCode = run.status ?? 1;',
  ].join('\n') + '\n');
  writeFileSync(join(box.repo, 'web/package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, MAIN_RED), testFile([MAIN_RED_CASE, 'main green case [G1]'], [MAIN_RED_CASE]));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'chore: main with one red case');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const repair = fixtureAdd(box.run, box.repo, 'web', `Main red: ${MAIN_RED}`, '--specs', 'G1', '--route', 'strong',
    '--criterion', `Repair this exact case on main: ${MAIN_RED_CASE}.`, '--brief', `Files:\n- ${MAIN_RED}\nTest:\n- ${MAIN_RED}\n`,
    '--check', `node web/runner.js ${MAIN_RED}`, '--wait', '--json');
  assert.equal(repair.code, 0, repair.err + repair.out);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Change beside a main red', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The change lands beside main\'s own red.', '--brief', `Files:\n- web/snapshot.txt\nTest:\n- ${MAIN_RED}\n`,
    '--check', `node web/runner.js ${MAIN_RED}`, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  return { box, id: JSON.parse(added.out).item.item_id, repair: JSON.parse(repair.out).item.item_id };
}

/** The queued submit's job, the item's gate verdicts and its last submit event, read from the real board file read-only. */
function boardRecord(box, id) {
  const db = openBoardReadOnly(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const submit = db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'submit' ORDER BY event_id DESC LIMIT 1").get(id);
    return { job: handoffRecord(db, id) ?? null, verdicts: jobs.jobsOf(db, { kind: GATE_VERDICT_KIND, item: id }),
      submit: submit ? JSON.parse(submit.event_detail) : null };
  } finally { db.close(); }
}

/** Claim, commit and submit the item through the real queued worker; returns its submitted commit. */
async function submitQueued(helpers, box, id) {
  const claimed = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const source = JSON.parse(claimed.out).itemFolder ?? box.web;
  const committed = helpers.commitFile(box, source, 'web/snapshot.txt', 'candidate\n', 'feat(web): change beside a main red [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.run(source, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  await helpers.waitFor(() => ['green', 'infrastructure', 'red', 'incomplete'].includes(boardRecord(box, id).job?.state), // budget: real queued worker hang ceiling
    'queued worker terminal result', 100_000); // budget: hang ceiling for one real queued gate; no elapsed-time assertion
  return box.git(source, 'rev-parse', 'HEAD');
}

/** Accept the item at its submitted commit as the coordinator, from the main checkout. */
function accept(box, id, commit) {
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const verdict = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'private landing fixture check passed');
    assert.equal(verdict.code, 0, verdict.err + verdict.out);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Run one real landing batch on the fixture board and return its record and the landing's own lines. */
function landBatch(box, itemId) {
  const href = path => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
  const source = [
    `import * as store from ${href('../../../../../packages/store/index.js')};`,
    `import { openBoard } from ${href('../../../../lib/index.js')};`,
    `import { loadConfig } from ${href('../../../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${href('../../../../../packages/landing/index.js')};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${href('../../../../runner/index.js')};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, itemId] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (failure) { error = failure.code ?? String(failure); }',
    'const batch = store.landingBatches(board).at(-1); const item = store.getItem(board, Number(itemId));',
    'console.log(JSON.stringify({ error, lines, batch, merged: item.item_merged_commit, status: item.item_status }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(itemId)], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

/** Remove the fixtures without blocking the main thread once the owned worker has let go. */
async function cleanupQueued(helpers, box) {
  try {
    const jobsDir = join(box.repo, '.git/pullboard/submit-handoffs');
    const idle = () => !existsSync(jobsDir) || readdirSync(jobsDir).every(job => !existsSync(join(jobsDir, job, 'source')));
    await helpers.waitFor(idle, 'owned worker cleanup', 20_000); // budget: hang ceiling for the owned worker's exit; no elapsed-time assertion
  } catch { /* A worker still running past the ceiling is removed with its fixture below. */ }
  await Promise.all(helpers.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
}

test('clause 1: a submit recorded green by the main-owned rule is reused at the real automatic landing instead of running the plan [C7,#3685]', { timeout: 200_000 }, async t => {
  const helpers = createE2eHelpers();
  const { box, id, repair } = mainRedLandingProject(helpers);
  t.after(() => cleanupQueued(helpers, box));
  const commit = await submitQueued(helpers, box, id);
  const record = boardRecord(box, id);
  assert.equal(record.job.state, 'green', JSON.stringify(record.job));
  const verdict = record.verdicts.at(-1)?.steps.find(step => step.name === 'verdict')?.payload;
  assert.equal(verdict?.green, true, `the submit gate recorded the main-owned verdict green: ${JSON.stringify(record.verdicts)}`);
  assert.deepEqual(verdict.mainOwned.map(({ file, name }) => [file, name]), [[MAIN_RED, MAIN_RED_CASE]]);
  assert.equal(record.submit.gateGreen, true);
  assert.deepEqual(record.submit.submissionProof.knownMainFailures?.failures.map(row => [row.file, row.name, row.item]), [[MAIN_RED, MAIN_RED_CASE, repair]],
    `the receipt still lists main's red against its repair: ${JSON.stringify(record.submit)}`);
  assert.match(record.submit.tooling ?? '', /^[a-f0-9]{40,64}$/u, 'the submit records the tooling tree that judged it');
  accept(box, id, commit);
  const result = landBatch(box, id);
  assert.equal(result.error, null, JSON.stringify(result.lines));
  assert.ok(result.lines.some(line => line.includes(`reused #${id}'s submit receipt`)), `landing reuses the main-owned green receipt: ${result.lines.join('\n')}`);
  assert.ok(result.lines.some(line => line.includes(`main-owned case(s): ${MAIN_RED} :: ${MAIN_RED_CASE}`)), result.lines.join('\n'));
  assert.ok(!result.lines.some(line => /selected; running|run finished/u.test(line)), `no landing test run started: ${result.lines.join('\n')}`);
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.batch));
  assert.ok(result.merged, 'the item lands on its reused verdict');
  assert.equal(boardRecord(box, repair).submit, null, 'main\'s red stays owned by its open repair, which nothing submitted for');
});

test('clause 1: control: known main failures not covered by a green main-owned verdict are never reused [C7,#3685]', () => {
  const treeOf = rev => ({ main1: 'treeBase', policy: 'treeBase' })[rev] ?? null;
  const known = { main: 'main1', failures: [{ file: MAIN_RED, name: MAIN_RED_CASE, item: 2 }] };
  const submit = { commit: 'c1', tree: 'treeC', tooling: 'treeT', policyCommit: 'policy', gateGreen: true,
    submissionProof: { version: 1, files: ['test/a.test.js'], full: false, deferred: false, knownMainFailures: known } };
  const input = verdict => ({ items: [{ id: 7, commit: 'c1' }], readEvents: () => [{ event_kind: 'submit', event_detail: JSON.stringify(submit) }],
    tree: 'treeC', base: 'main1', tooling: 'treeT', full: false, files: ['test/a.test.js', MAIN_RED], treeOf, verdictOf: () => verdict });
  const green = { green: true, mainOwned: [{ file: MAIN_RED, name: MAIN_RED_CASE, receipt: 'r1' }] };
  assert.equal(landingReceiptReuse(input(green)).reuse, true, 'a green verdict owning every listed case is reused, its file counted as proved');
  assert.equal(landingReceiptReuse(input(null)).code, 'NOT_GREEN', 'no verdict: the receipt is red');
  assert.equal(landingReceiptReuse(input({ ...green, green: false })).code, 'NOT_GREEN', 'a red verdict is never reused');
  assert.equal(landingReceiptReuse(input({ green: true, mainOwned: [{ file: MAIN_RED, name: 'another case' }] })).code, 'NOT_GREEN', 'a case the verdict does not own stays red');
  const changed = { ...input(green), tree: 'treeD', generated: ['docs/badges/items.json'] };
  assert.equal(landingReceiptReuse({ ...changed, changedPaths: () => ['docs/badges/items.json'] }).reuse, true, 'a tree changed only by the landing\'s own badge write is the proved tree');
  assert.equal(landingReceiptReuse({ ...changed, changedPaths: () => ['docs/badges/items.json', 'src/a.js'] }).code, 'CANDIDATE_CHANGED', 'any other change runs the gate');
});

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures({ sandbox: e2e.sandbox, project: e2e.project, commitFile: e2e.commitFile });
const LAND_RED = 'web/land-9.test.js';

/** A per-item separate-publish landing project whose main already carries one red case, committed through real hooks. */
function landRedMainProject() {
  const box = landProject({ withWorktree: false });
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, perItem: true, manualOverride: true, publish: 'separate' } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    assert.equal(e2e.commitFile(box, box.repo, LAND_RED, '// RED NAME:main-red-case\n', 'test(web): a case red on main [G1]').status, 0);
    assert.equal(e2e.commitFile(box, box.repo, 'web/land-1.test.js', '// PASS\n', 'test(web): a case green on main [G1]').status, 0);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  return box;
}

/** Submit and accept one item with its red suppressed, then move main so the landing gate runs on the merged tree. */
function acceptedLandItem(box, number, contents) {
  box.env.LAND_SUPPRESS_RED = '1';
  let entry;
  try {
    entry = itemWorktree(box, number);
    submitItem(box, entry, contents);
    acceptItem(box, entry);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  moveMainPastSubmit(box, number);
  return entry;
}

test('clause 2: a real landing gate whose only failing case is red at the main it merges onto lands the batch, the red owned by main [C7,#3685]', () => {
  const box = landRedMainProject();
  const entry = acceptedLandItem(box, 2, '// PASS\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.equal(result.error, null, JSON.stringify(result.lines));
  assert.ok(result.lines.some(line => /run finished red/u.test(line)), `the landing gate ran and was red: ${result.lines.join('\n')}`);
  assert.ok(result.lines.some(line => /known main red/u.test(line) && line.includes(`${LAND_RED} :: main-red-case`)), result.lines.join('\n'));
  assert.ok(result.merged, `the item lands: ${JSON.stringify(result.lines)}`);
  assert.deepEqual(result.batch.proof.knownMain.map(row => [row.file, row.name]), [[LAND_RED, 'main-red-case']]);
  assert.ok(!(result.batch.culprits ?? []).length, 'nothing is charged to the item');
  assert.deepEqual(result.batch.mainRedRepairs.map(row => row.file), [LAND_RED], 'the red stays owned by a Main red item for its file');
});

test('clause 2: a real landing gate with a failing case that is green on main still fails the batch and names the item [C7,#3685]', () => {
  const box = landRedMainProject();
  const entry = acceptedLandItem(box, 1, '// RED NAME:batch-red-case\n');
  box.env.LAND_CANCEL = '1';
  const result = landBatch(box, entry.item);
  assert.ok(result.lines.some(line => /run finished red/u.test(line)), `the landing gate ran and was red: ${result.lines.join('\n')}`);
  assert.equal(result.merged, null, 'the item stays off main');
  assert.notEqual(result.batch.state, 'landed');
  assert.ok(result.batch.culprits.some(culprit => culprit.id === entry.item && culprit.tests.some(row => row.name === 'batch-red-case')), JSON.stringify(result.batch));
  assert.ok(!result.batch.culprits.some(culprit => JSON.stringify(culprit).includes(LAND_RED)), 'main\'s own red is never a reason');
});
