/** The automatic lander runs a held test itself at the trunk and closes the defect when it passes, once per trunk commit [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureCommittedPolicy } from '../../../tests/fixtures/testkit.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import * as store from '../../../../../packages/store/index.js';
import { closePassedTestDefects } from '../../../../../packages/landing/index.js';

const HELD = 'web/held.test.js';
const CASE = 'held case [C7]';
const BRANCH = 'refs/heads/main';
const REVIEWER_MODEL = 'Landing reviewer';

/** Require an actual successful JSON command. */
async function json(box, root, ...args) {
  const result = await box.runIn(root, ...args, '--json');
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Commit fixture source through the installed ordinary hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** A board that lands accepted items itself, a committed green test on its trunk, and a reviewer seat; no runners, so the held file runs locally. */
async function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', affectedTests: 'node --test', landing: { perItem: false, publish: 'separate', manualOverride: false } };
  fixtureCommittedPolicy(box, config);
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, HELD), `import { test } from 'node:test';\ntest('${CASE}', () => {});\n`);
  commit(box, box.repo, 'chore: the board lands accepted items and a held test is committed');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  await json(box, reviewer, 'join', 'api', '--model', REVIEWER_MODEL, '--route', 'strong');
  return { box, reviewer };
}

/** Build one web item and submit it, leaving it for the reviewer. */
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

/** File the defect the automatic lander files for a no-culprit red of the held test. */
async function fileDefect(box, batchId) {
  return onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(readFileSync(join(box.repo, HELD))).digest('hex'),
    blob: box.git(box.repo, 'rev-parse', `HEAD:${HELD}`), trunkBlob: null, names: [CASE], lane: 'web', batchId, branch: BRANCH }));
}

test('clause 1: with no recorded run, the automatic lander runs the held green file at the trunk, closes the defect and lands the batch [C7]', { timeout: 300_000 }, async t => { // budget: one real accept-to-merged landing plus one local run of a one-case file in a private repo; hang ceiling, not speed.
  const { box, reviewer } = await fixture(t);
  const item = await submitted(box, 'first');
  const defect = await fileDefect(box, '44444444-4444-4444-8444-444444444444');
  box.git(reviewer, 'checkout', '-q', '--detach', item.head);
  const accepted = await box.runIn(reviewer, 'verify', String(item.id), 'accept', '--note', 'Read the change and ran its frozen check.', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.doesNotMatch(accepted.out + accepted.err, /LAND_TEST_DEFECT/u);
  assert.ok((await json(box, box.repo, 'show', String(item.id))).item_merged_commit, `the batch lands behind a green hold: ${accepted.out}${accepted.err}`);
  const closed = onBoard(box, board => store.events(board).filter(event => event.event_kind === 'landing-test-defect-closed').map(event => JSON.parse(event.event_detail).closed));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].item, defect.item);
});

test('clause 2: a held file still red at the trunk keeps the hold and runs once per trunk commit [C7]', async () => {
  const defect = { branch: BRANCH, test: HELD, item: 7, names: [CASE] };
  const trunk = { branch: BRANCH, commit: 'a'.repeat(40) };
  const runs = [];
  const writes = [];
  const red = { main: trunk.commit, files: [{ file: HELD, result: 'red', failures: [{ file: HELD, name: CASE }], signatureVersion: 1 }] };
  const options = { defects: () => [defect], comparison: () => red, measure: async (...args) => { runs.push(args); return red; } };
  const call = () => closePassedTestDefects({ root: '/nowhere', board: {}, trunk, write: async (...args) => { writes.push(args); return {}; } }, options);
  assert.deepEqual(await call(), []);
  assert.deepEqual(await call(), []);
  assert.equal(runs.length, 1, 'the red file ran once at this trunk commit');
  assert.equal(runs[0][4].commit, trunk.commit);
  assert.deepEqual(writes, [], 'the hold stays');
  await closePassedTestDefects({ root: '/nowhere', board: {}, trunk: { ...trunk, commit: 'b'.repeat(40) }, write: async () => ({}) }, options);
  assert.equal(runs.length, 2, 'a newer trunk commit runs it again');
});
