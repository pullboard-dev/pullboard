/** A trunk test defect whose cases passed at a trunk commit closes for good through the automatic lander [C7]. */
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
import { onBoard } from '../../../tests/fixtures/land/board.js';
import * as store from '../../../../../packages/store/index.js';
import { heldTestDefects } from '../../../../../packages/landing/index.js';
import { landingPorts } from '../../../tests/fixtures/landing/ports.js';

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

/** A board that lands accepted items itself, with a committed test on its trunk and a reviewer seat in another lane. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', landing: { perItem: false, publish: 'separate', manualOverride: false } };
  const policy = join(box.repo, 'pullboard.json');
  writeFileSync(policy, JSON.stringify(config));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, HELD), `import { test } from 'node:test';\ntest('${CASE}', () => {});\n`);
  commit(box, box.repo, 'chore: the board lands accepted items and a held test is committed');
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

/** Accept from the reviewer seat; the board's automatic lander runs inside this accept. */
function accept(box, reviewer, item) {
  box.git(reviewer, 'checkout', '-q', '--detach', item.head);
  return box.run(reviewer, 'verify', String(item.id), 'accept', '--note', 'Read the change and ran its frozen check.', '--json');
}

/** File the defect the automatic lander files for a no-culprit red of the held test. */
function fileDefect(box, batchId) {
  return onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(readFileSync(join(box.repo, HELD))).digest('hex'),
    blob: box.git(box.repo, 'rev-parse', `HEAD:${HELD}`), trunkBlob: null, names: [CASE], lane: 'web', batchId, branch: BRANCH }));
}

/** Record a green run of the held test at one trunk commit in the machine's main comparison cache. */
function recordGreen(box, trunk) {
  const file = join(box.repo, '.git', 'pullboard', 'main-red.json');
  writeFileSync(file, JSON.stringify({ version: 2, entries: { [trunk]: { [HELD]: { result: 'green' } } } }), { mode: 0o600 });
}

/** The defects the real landing step holds the current trunk with, read from the board or from a given list. */
function held(box, defects) {
  return onBoard(box, board => heldTestDefects(box.repo, board, { branch: BRANCH, commit: box.git(box.repo, 'rev-parse', 'main') }, landingPorts,
    defects ? { defects: () => defects } : {}));
}

/** The closing events the board recorded. */
function closings(box) {
  return onBoard(box, board => store.events(board).filter(event => event.event_kind === 'landing-test-defect-closed').map(event => JSON.parse(event.event_detail).closed));
}

test('clause 1: after the held cases pass at one trunk commit the automatic lander records the defect closed, and a landing at a newer trunk commit is not refused LAND_TEST_DEFECT [C7]', { timeout: 300_000 }, t => { // budget: two real accept-to-merged landings in a private repo; hang ceiling, not speed.
  const { box, reviewer } = fixture(t);
  const first = submitted(box, 'first');
  const defect = fileDefect(box, '11111111-1111-4111-8111-111111111111');
  const trunkA = box.git(box.repo, 'rev-parse', 'main');
  assert.deepEqual(held(box).map(row => row.item), [defect.item], 'the filed defect holds the trunk');

  recordGreen(box, trunkA);
  const firstAccept = accept(box, reviewer, first);
  assert.equal(firstAccept.code, 0, firstAccept.out + firstAccept.err);
  const firstMerged = json(box, box.repo, 'show', String(first.id)).item_merged_commit;
  assert.ok(firstMerged, `the first item lands at the trunk its held cases passed at: ${firstAccept.out}${firstAccept.err}`);
  assert.deepEqual(closings(box), [{ branch: BRANCH, test: HELD, item: defect.item, commit: trunkA }],
    'the real landing path records the defect closed at the trunk commit its cases passed at');
  assert.deepEqual(onBoard(box, board => store.landingTestDefects(board)), [], 'a closed defect is no longer returned');

  const trunkB = box.git(box.repo, 'rev-parse', 'main');
  assert.notEqual(trunkB, trunkA, 'the landing moved the trunk past the recorded run');
  assert.deepEqual(held(box, [defect]).map(row => row.item), [defect.item],
    'without its closing the same defect would hold the newer trunk: nothing recorded the test there');

  const second = submitted(box, 'second');
  const secondAccept = accept(box, reviewer, second);
  assert.equal(secondAccept.code, 0, secondAccept.out + secondAccept.err);
  assert.doesNotMatch(secondAccept.out + secondAccept.err, /LAND_TEST_DEFECT/u);
  const secondMerged = json(box, box.repo, 'show', String(second.id)).item_merged_commit;
  assert.ok(secondMerged, `the next landing at the newer trunk is not held: ${secondAccept.out}${secondAccept.err}`);
  box.git(box.repo, 'merge-base', '--is-ancestor', firstMerged, secondMerged);
  assert.equal(closings(box).length, 1, 'the closing is recorded once');
});

test('clause 2: a new red of the same cases after closure files a new defect that holds the trunk again [C7]', { timeout: 300_000 }, t => { // budget: one real accept-to-merged landing and one held accept in a private repo; hang ceiling, not speed.
  const { box, reviewer } = fixture(t);
  const first = submitted(box, 'first');
  const defect = fileDefect(box, '22222222-2222-4222-8222-222222222222');
  recordGreen(box, box.git(box.repo, 'rev-parse', 'main'));
  const firstAccept = accept(box, reviewer, first);
  assert.equal(firstAccept.code, 0, firstAccept.out + firstAccept.err);
  assert.ok(json(box, box.repo, 'show', String(first.id)).item_merged_commit, firstAccept.out + firstAccept.err);
  assert.equal(closings(box).length, 1, 'the defect closed through the real landing path');
  assert.deepEqual(held(box), [], 'the closed defect holds nothing');

  const again = fileDefect(box, '33333333-3333-4333-8333-333333333333');
  assert.notEqual(again.item, defect.item, 'the new red files a new defect with its own repair item');
  assert.deepEqual(again.names, [CASE]);
  assert.deepEqual(onBoard(box, board => store.landingTestDefects(board)).map(row => row.item), [again.item]);
  assert.deepEqual(held(box).map(row => row.item), [again.item], 'the new defect holds the trunk again');

  const trunk = box.git(box.repo, 'rev-parse', 'main');
  const second = submitted(box, 'second');
  accept(box, reviewer, second);
  assert.equal(json(box, box.repo, 'show', String(second.id)).item_merged_commit, null, 'the automatic lander holds the next landing');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), trunk, 'the held trunk does not move');
  assert.equal(closings(box).length, 1, 'the new defect stays open: no run at this trunk shows its cases passing');
});
