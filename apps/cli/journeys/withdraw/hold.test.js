/** @pullboard-test-input apps/cli/src/io/landing/automatic.js */
/** A recorded test defect is a repair item, never a trunk hold: the lander lands beside it [C7,#5862]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import * as store from '../../../../packages/store/index.js';

const HELD = 'web/held.test.js';
const CASE = 'held case [C7]';
const BRANCH = 'refs/heads/main';
/** The reviewers' model, apart from the builders' fixture model. */
const REVIEWER_MODEL = 'Landing reviewer';

/** Require an actual successful JSON command. */
async function json(box, root, ...args) {
  const result = await box.runLocal(root, ...args, '--json');
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
async function fixture(t) {
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
  await json(box, reviewer, 'join', 'api', '--model', REVIEWER_MODEL, '--route', 'strong');
  return { box, reviewer };
}

/** Build one web item on the current trunk and submit it, leaving it for the reviewer. */
async function submitted(box, name) {
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const file = `web/${name}.txt`;
  const id = (await json(box, box.repo, 'add', 'web', `Build ${name}`, '--specs', 'G1', '--criterion', `${file} exists`, '--check', `test -f ${file}`)).item.item_id;
  await json(box, box.web, 'claim', String(id));
  writeFileSync(join(box.web, file), `${name}\n`);
  const head = commit(box, box.web, `feat(web): build ${name} [G1]`);
  await json(box, box.web, 'submit', String(id));
  return { id, head };
}

/** File the defect the automatic lander files for a no-culprit red of the held test; its repair item is open. */
function fileDefect(box) {
  return onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(readFileSync(join(box.repo, HELD))).digest('hex'),
    blob: box.git(box.repo, 'rev-parse', `HEAD:${HELD}`), trunkBlob: null, names: [CASE], lane: 'web',
    batchId: '55555555-5555-4555-8555-555555555555', branch: BRANCH }));
}

/** An open test defect on the trunk, with one item accepted after it was filed. */
async function acceptedBesideDefect(t) {
  const { box, reviewer } = await fixture(t);
  const item = await submitted(box, 'waiting');
  const defect = fileDefect(box);
  box.git(reviewer, 'checkout', '-q', '--detach', item.head);
  await box.runLocal(reviewer, 'verify', String(item.id), 'accept', '--note', 'Read the change and ran its frozen check.', '--json');
  assert.equal((await json(box, box.repo, 'show', String(item.id))).item_status, 'verified', 'the item is accepted');
  return { box, item, defect };
}

/** Whether the board recorded the item merged. */
function merged(box, id) {
  return onBoard(box, board => store.getItem(board, id).item_merged_commit ?? null);
}

/**
 * One pass of the scheduled lander exactly as its timer runs it: apps/cli/src/io/landing/automatic.js runLandingWake with the real
 * landing, in a child whose stdout is what the scheduler keeps as worker.log. Only its clock is injected, so a back-off
 * is waited out at once.
 */
function landerPass(box) {
  const source = [
    `import { runLandingWake } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../src/io/landing/automatic.js')).href)};`,
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

test('clause 1: an open test-defect repair item no longer holds the trunk: the lander\'s first pass lands the waiting accepted item [C7,#5862]', { timeout: 300_000 }, async t => { // budget: one accept and one real lander pass in a private repo; hang ceiling, not speed.
  const { box, item, defect } = await acceptedBesideDefect(t);
  assert.equal(onBoard(box, board => store.getItem(board, defect.item).item_status), 'open', 'the repair item is still open');
  // No pullboard land and no withdrawal: the accept-time landing or the scheduled lander's own pass lands the item.
  const pass = merged(box, item.id) ? { log: '' } : landerPass(box);
  assert.doesNotMatch(pass.log, /LAND_TEST_DEFECT/u, `the pass is not refused: ${pass.log}`);
  assert.ok(merged(box, item.id), `the accepted item lands beside the open defect: ${pass.log}`);
});
