/** An accept from any seat's own session lands through the board's landing worker for the main checkout [B35,B3,R3]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../../tests/fixtures/e2e.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import * as store from '../../../../../packages/store/index.js';
import { automaticLandingDirectory } from '../../../../../packages/landing/index.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';

const BIN = new URL('../../../pullboard.js', import.meta.url).pathname;
/** The reviewers' model, apart from the builders' fixture model. */
const REVIEWER_MODEL = 'Landing reviewer';

/** The environment of one real agent session; the fixture itself keeps none. */
function sessionEnv(box, identity) {
  return { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: identity };
}

/** Run one public command as an agent session and demand its JSON success. */
function jsonAs(box, identity, cwd, ...args) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  Object.assign(box.env, sessionEnv(box, identity));
  try {
    const result = box.run(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.out + result.err);
    return JSON.parse(result.out);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/** Commit fixture source through the installed ordinary hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Read the main checkout's local session binding, which only its own session may hold. */
function mainBinding(box) {
  return readFileSync(join(box.repo, '.git', 'pullboard-checkout-session.json'), 'utf8');
}

/**
 * A board whose main checkout belongs to the coordinator's session, with one submitted item per builder lane and a
 * reviewer worktree, joined in its own session, at each submitted head.
 */
function fixture(t, lanes) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', landing: { perItem: false, publish: 'separate', manualOverride: false } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  for (const lane of ['web', 'api']) mkdirSync(join(box.repo, lane), { recursive: true });
  writeFileSync(join(box.repo, 'web/result.txt'), 'base\n');
  writeFileSync(join(box.repo, 'api/answer.txt'), 'base\n');
  commit(box, box.repo, 'chore: configure automatic landing');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const builders = { web: box.web };
  if (lanes.includes('api')) {
    builders.api = join(box.dir, 'api-1');
    box.git(box.repo, 'worktree', 'add', '-q', builders.api, '-b', 'api/one');
    joinFixtureSeat(box, builders.api, 'api', { model: FIXTURE_MODEL }); // the strong route, as the web seat joined
  }
  const files = { web: 'web/result.txt', api: 'api/answer.txt' };
  const items = lanes.map((lane, index) => {
    const id = jsonAs(box, 'coordinator-session', box.repo, 'add', lane, `Build ${lane}`, '--specs', lane === 'api' ? 'G2' : 'G1',
      '--criterion', `the ${lane} file is built`, '--check', `grep -q built ${files[lane]}`).item.item_id;
    const builder = builders[lane];
    assert.equal(box.run(builder, 'claim', String(id)).code, 0);
    writeFileSync(join(builder, files[lane]), 'built\n');
    const head = commit(box, builder, `feat(${lane}): build the ${lane} file [${lane === 'api' ? 'G2' : 'G1'}]`);
    const submitted = box.run(builder, 'submit', String(id));
    assert.equal(submitted.code, 0, submitted.out + submitted.err);
    const reviewer = join(box.dir, `reviewer-${index}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
    jsonAs(box, `reviewer-session-${index}`, reviewer, 'join', lane === 'web' ? 'api' : 'web', '--model', REVIEWER_MODEL, '--route', 'strong');
    return { id, head, reviewer, session: `reviewer-session-${index}`, file: files[lane] };
  });
  return { box, items, binding: mainBinding(box) };
}

/** Accept in the reviewer's own session, outside the main checkout, and keep the full command result. */
function accept(box, item) {
  return runFixtureChildAsync(process.execPath, [BIN, 'verify', String(item.id), 'accept', '--note', 'Read the diff and ran its frozen check.'],
    { cwd: item.reviewer, env: sessionEnv(box, item.session), stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Wait, with the test's own deadline, until every item carries its landing commit and the worker has finished its wake. */
async function landed(box, items) {
  const pending = join(automaticLandingDirectory(box.repo), 'pending.json');
  await waitForCondition(() => !existsSync(pending) && onBoard(box, board => items.every(item => store.getItem(board, item.id).item_merged_commit)),
    'the board landing worker lands every accepted item', {
      signal: AbortSignal.timeout(180_000),
      state: () => ({ pending: existsSync(pending) ? readFileSync(pending, 'utf8') : null,
        items: onBoard(box, board => items.map(item => [item.id, store.getItem(board, item.id).item_status])) }),
    });
}

/** Prove each accepted head is on main, its file is landed, and the main checkout still belongs to its own session. */
function assertLanded(box, items, binding) {
  for (const item of items) {
    const merged = onBoard(box, board => store.getItem(board, item.id).item_merged_commit);
    box.git(box.repo, 'merge-base', '--is-ancestor', item.head, 'main');
    box.git(box.repo, 'merge-base', '--is-ancestor', merged, 'main');
    assert.equal(box.git(box.repo, 'show', `main:${item.file}`).trim(), 'built');
  }
  assert.equal(mainBinding(box), binding, 'landing never rebinds the coordinator session’s checkout');
}

test('an accept from a reviewer worktree session lands on main with no command in the main checkout [B35,B3,R3]', async t => {
  const { box, items, binding } = fixture(t, ['web']);
  const result = await accept(box, items[0]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /NOT_YOUR_CHECKOUT|automatic landing retained/u);
  await landed(box, items);
  assertLanded(box, items, binding);
});

test('two accepts at once from two sessions land both, each in a batch of one [B35,B3,R3,C7]', async t => {
  const { box, items, binding } = fixture(t, ['web', 'api']);
  // The board's own batch size (Corey 5 Nov). An accept's landing starts at once, with no 10 s wait to gather accepts.
  onBoard(box, board => store.setLineSetting(board, { agentId: 'coordinator', key: 'landingBatchSize', value: 1,
    reason: 'Batch size stays one', window: { windowMinutes: 60, activeReviewers: 2, reviewWaitMedianMinutes: 40 } }));
  const before = onBoard(box, board => store.landingBatches(board).length);
  const results = await Promise.all(items.map(item => accept(box, item)));
  for (const result of results) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /NOT_YOUR_CHECKOUT|automatic landing retained/u);
  }
  await landed(box, items);
  assertLanded(box, items, binding);
  const batches = onBoard(box, board => store.landingBatches(board)).slice(before).filter(batch => batch.state === 'landed');
  assert.deepEqual(batches.map(batch => (batch.items ?? []).length), [1, 1], 'concurrent accepts land one item per batch');
});
