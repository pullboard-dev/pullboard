/** @pullboard-test-input source-tree */
/** A trunk test-defect hold follows its repair item's live status, and the lander's refusal names the item and status [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { onBoard } from './land-board-fixture.js';
import { runFixtureChild } from './fixture-child.js';
import { fixtureProjectPolicy } from './testkit-fixture.js';
import * as store from '../packages/store/index.js';
import { heldTestDefects } from '../packages/landing/index.js';
import { landingPorts } from './landing-ports-fixture.js';

const HELD = 'web/held.test.js';
const CASE = 'held case [C7]';
const BRANCH = 'refs/heads/main';
/** The reviewers' model, apart from the builders' fixture model. */
const REVIEWER_MODEL = 'Landing reviewer';

/** Require an actual successful JSON command. */
function json(box, root, ...args) {
  const result = box.run(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Commit fixture source through the installed ordinary hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/**
 * A board that lands accepted items itself, with a committed test on its trunk whose case really fails, so no run at
 * the trunk can release its defect, and a reviewer seat in another lane.
 */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', landing: { perItem: false, publish: 'separate', manualOverride: false } };
  fixtureProjectPolicy(box.repo, { config });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, HELD), `import { test } from 'node:test';\ntest('${CASE}', () => { throw new Error('still red'); });\n`);
  commit(box, box.repo, 'chore: the board lands accepted items and a red held test is committed');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  json(box, reviewer, 'join', 'api', '--model', REVIEWER_MODEL, '--route', 'strong');
  return { box, reviewer };
}

/** Build one web item on the current trunk and submit it, leaving it for the reviewer. */
function submitted(box, name) {
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const file = `web/${name}.txt`;
  const id = json(box, box.repo, 'add', 'web', `Build ${name}`, '--specs', 'G1', '--criterion', `${file} exists`, '--check', `test -f ${file}`).item.item_id;
  json(box, box.web, 'claim', String(id));
  writeFileSync(join(box.web, file), `${name}\n`);
  const head = commit(box, box.web, `feat(web): build ${name} [G1]`);
  json(box, box.web, 'submit', String(id));
  return { id, head };
}

/** File the defect the automatic lander files for a no-culprit red of the held test; its repair item is open. */
function fileDefect(box) {
  return onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(readFileSync(join(box.repo, HELD))).digest('hex'),
    blob: box.git(box.repo, 'rev-parse', `HEAD:${HELD}`), trunkBlob: null, names: [CASE], lane: 'web',
    batchId: '55555555-5555-4555-8555-555555555555', branch: BRANCH }));
}

/** A trunk held by an open test defect, with one accepted item the real lander refused to land behind it. */
function heldBehindDefect(t) {
  const { box, reviewer } = fixture(t);
  const item = submitted(box, 'waiting');
  const defect = fileDefect(box);
  box.git(reviewer, 'checkout', '-q', '--detach', item.head);
  box.run(reviewer, 'verify', String(item.id), 'accept', '--note', 'Read the change and ran its frozen check.', '--json');
  assert.equal(json(box, box.repo, 'show', String(item.id)).item_status, 'verified', 'the item is accepted');
  assert.equal(merged(box, item.id), null, 'the open defect held the accept-time landing');
  return { box, item, defect };
}

/** Whether the board recorded the item merged. */
function merged(box, id) {
  return onBoard(box, board => store.getItem(board, id).item_merged_commit ?? null);
}

/** The defects the real landing step holds the current trunk with. */
function held(box) {
  return onBoard(box, board => heldTestDefects(box.repo, board, { branch: BRANCH, commit: box.git(box.repo, 'rev-parse', 'main') }, landingPorts));
}

/**
 * One pass of the scheduled lander exactly as its timer runs it: bin/automatic-landing.js runLandingWake with the real
 * landing, in a child whose stdout is what the scheduler keeps as worker.log. Only its clock is injected, so a back-off
 * is waited out at once.
 */
function landerPass(box) {
  const source = [
    `import { runLandingWake } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../bin/automatic-landing.js')).href)};`,
    'const { root } = JSON.parse(process.argv[1]); let clock = Date.now();',
    'const result = await runLandingWake(root, { loaded: null, now: () => clock, wait: async ms => { clock += ms; } });',
    'console.log("RESULT " + JSON.stringify(result ? { ...result, workerUrl: String(result.workerUrl) } : null));',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({ root: box.repo })],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  const line = run.stdout.split('\n').find(text => text.startsWith('RESULT '));
  return { log: run.stdout, result: JSON.parse(line.slice('RESULT '.length)) };
}

test('clause 1: a trunk held by a test-defect item that is then withdrawn: the lander\'s next pass drops the hold and lands the waiting accepted item, with no coordinator landing [C7]', { timeout: 300_000 }, t => { // budget: one held accept and two real lander passes in a private repo; hang ceiling, not speed.
  const { box, item, defect } = heldBehindDefect(t);
  assert.deepEqual(held(box).map(row => [row.item, row.status]), [[defect.item, 'open']], 'the open repair item holds the trunk');
  const refused = landerPass(box);
  assert.equal(refused.result?.backoff?.outcome, 'LAND_TEST_DEFECT', `the lander's pass is refused while the item is open: ${refused.log}`);
  assert.deepEqual(Object.keys(refused.result.backoff.marks.held), [HELD], 'the backed-off lander watches the held test file');
  assert.equal(merged(box, item.id), null);

  const withdrawn = box.run(box.repo, 'withdraw', String(defect.item), 'the held test needs no repair');
  assert.equal(withdrawn.code, 0, withdrawn.out + withdrawn.err);
  assert.equal(onBoard(box, board => store.getItem(board, defect.item).item_status), 'withdrawn');
  assert.deepEqual(onBoard(box, board => store.landingTestDefects(board)).map(row => row.item), [defect.item],
    'the defect record is unchanged: the hold follows the item\'s live status, not a cleared record');
  assert.deepEqual(held(box), [], 'a withdrawn repair item holds nothing');

  // No pullboard land: the scheduled lander's own next pass lands the waiting item.
  const next = landerPass(box);
  assert.doesNotMatch(next.log, /LAND_TEST_DEFECT/u, 'the next pass is not refused');
  assert.ok(merged(box, item.id), `the lander's next pass lands the waiting accepted item: ${next.log}`);
  assert.deepEqual(onBoard(box, board => store.events(board).filter(event => event.event_kind === 'landing-test-defect-closed')), [],
    'nothing closed the defect, and its test is still red: the withdrawal alone released the trunk');
});

test('clause 2: the lander\'s LAND_TEST_DEFECT refusal names the defect item and its live status in worker.log [C7]', { timeout: 300_000 }, t => { // budget: one held accept and one real lander pass in a private repo; hang ceiling, not speed.
  const { box, defect } = heldBehindDefect(t);
  const pass = landerPass(box);
  assert.match(pass.log, new RegExp(`landing held: \\[LAND_TEST_DEFECT\\] this trunk is held by #${defect.item} \\(open; web/held\\.test\\.js\\)`, 'u'),
    `the lander's stdout, kept as worker.log, names the holding item and its status: ${pass.log}`);
});
