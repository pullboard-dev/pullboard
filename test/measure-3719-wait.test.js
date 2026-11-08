/** The automatic lander runs a held test itself at the trunk and closes the defect when it passes, once per trunk commit [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureCommittedPolicy } from './testkit-fixture.js';
import { onBoard } from './land-board-fixture.js';
import * as store from '../packages/store/index.js';
import { closePassedTestDefects } from '../packages/landing/src/shell/landing-step-selection.js';

const HELD = 'web/held.test.js';
const CASE = 'held case [C7]';
const BRANCH = 'refs/heads/main';
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

/** A board that lands accepted items itself, a committed green test on its trunk, and a reviewer seat; no runners, so the held file runs locally. */
function fixture(t) {
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
  json(box, reviewer, 'join', 'api', '--model', REVIEWER_MODEL, '--route', 'strong');
  return { box, reviewer };
}

/** Build one web item and submit it, leaving it for the reviewer. */
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

/** File the defect the automatic lander files for a no-culprit red of the held test. */
function fileDefect(box, batchId) {
  return onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(readFileSync(join(box.repo, HELD))).digest('hex'),
    blob: box.git(box.repo, 'rev-parse', `HEAD:${HELD}`), trunkBlob: null, names: [CASE], lane: 'web', batchId, branch: BRANCH }));
}

test('measure #3719: seconds from accept until the batch lands behind a green hold [C7]', { timeout: 600_000 }, t => {
  const { box, reviewer } = fixture(t);
  const item = submitted(box, 'first');
  fileDefect(box, '44444444-4444-4444-8444-444444444444');
  box.git(reviewer, 'checkout', '-q', '--detach', item.head);
  const start = Date.now();
  const accepted = box.run(reviewer, 'verify', String(item.id), 'accept', '--note', 'Read the change and ran its frozen check.', '--json');
  const merged = () => Boolean(json(box, box.repo, 'show', String(item.id)).item_merged_commit);
  let attempts = 1;
  let landed = merged();
  while (!landed && attempts < 12) { box.run(box.repo, 'status', '--json'); attempts += 1; landed = merged(); }
  const refused = /LAND_TEST_DEFECT/u.test(accepted.out + accepted.err);
  console.log('MEASURE3719 ' + JSON.stringify({ landed, attempts, seconds: Math.round((Date.now() - start) / 100) / 10, firstAttemptRefusedLandTestDefect: refused }));
});
