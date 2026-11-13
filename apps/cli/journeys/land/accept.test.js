/** Accepted items land at once, in batches of one, on the automatic lander [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { landJobs } from '../../tests/fixtures/land/board.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import * as store from '../../../../packages/store/index.js';
import { cadenceApplies } from '../../../../packages/landing/index.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const BIN = new URL('../../pullboard.js', import.meta.url).pathname;
/** The reviewers' model, apart from the builders' fixture model. */
const REVIEWER_MODEL = 'Landing reviewer';
/** The criterion's bar: an accepted item's landing starts within this long of its ACCEPT. */
const START_WITHIN_MS = 60_000;
/** A 30-minute landing cadence that would hold a hand landing after the first batch. */
const CADENCE = '30m';

/**
 * The environment of one real agent session; the fixture itself keeps none.
 *
 * @param {object} box - The e2e project box.
 * @param {string} identity - The session id.
 * @returns {object}
 */
function sessionEnv(box, identity) {
  return { ...box.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: identity };
}

/**
 * Run one public command as an agent session and demand its JSON success.
 *
 * @param {object} box - The e2e project box.
 * @param {string} identity - The session id.
 * @param {string} cwd - Where the command runs.
 * @param {...string} args - The command's arguments.
 * @returns {Promise<object>}
 */
async function jsonAs(box, identity, cwd, ...args) {
  const previous = { CLAUDECODE: box.env.CLAUDECODE, CLAUDE_CODE_SESSION_ID: box.env.CLAUDE_CODE_SESSION_ID };
  Object.assign(box.env, sessionEnv(box, identity));
  try {
    const result = await box.runLocal(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.out + result.err);
    return JSON.parse(result.out);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete box.env[name];
      else box.env[name] = value;
    }
  }
}

/**
 * Commit fixture source through the installed ordinary hooks.
 *
 * @param {object} box - The e2e project box.
 * @param {string} root - The checkout to commit in.
 * @param {string} message - The commit message.
 * @returns {string} the new head
 */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/**
 * A board with automatic landing, a 30-minute landing cadence and the line's batch size of one (the board's own
 * setting, Corey 5 Nov), holding one submitted item in each of two lanes and a reviewer worktree at each head.
 *
 * @param {object} t - The test context.
 * @returns {Promise<{ box: object, items: object[] }>}
 */
async function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', landing: { perItem: false, publish: 'separate', manualOverride: false, cadence: CADENCE } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  for (const lane of ['web', 'api']) mkdirSync(join(box.repo, lane), { recursive: true });
  writeFileSync(join(box.repo, 'web/result.txt'), 'base\n');
  writeFileSync(join(box.repo, 'api/answer.txt'), 'base\n');
  commit(box, box.repo, 'chore: configure automatic landing on a cadence');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const api = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/one');
  await joinFixtureSeat(box, api, 'api', { model: FIXTURE_MODEL, run: box.runLocal }); // the strong route, as the web seat joined
  const builders = { web: box.web, api };
  const files = { web: 'web/result.txt', api: 'api/answer.txt' };
  const items = [];
  for (const [index, lane] of ['web', 'api'].entries()) {
    const id = (await jsonAs(box, 'coordinator-session', box.repo, 'add', lane, `Build ${lane}`, '--specs', lane === 'api' ? 'G2' : 'G1',
      '--criterion', `the ${lane} file is built`, '--check', `grep -q built ${files[lane]}`)).item.item_id;
    assert.equal((await box.runLocal(builders[lane], 'claim', String(id))).code, 0);
    writeFileSync(join(builders[lane], files[lane]), 'built\n');
    const head = commit(box, builders[lane], `feat(${lane}): build the ${lane} file [${lane === 'api' ? 'G2' : 'G1'}]`);
    const submitted = await box.runLocal(builders[lane], 'submit', String(id));
    assert.equal(submitted.code, 0, submitted.out + submitted.err);
    const reviewer = join(box.dir, `reviewer-${index}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, head);
    await jsonAs(box, `reviewer-session-${index}`, reviewer, 'join', lane === 'web' ? 'api' : 'web', '--model', REVIEWER_MODEL, '--route', 'strong');
    items.push({ id, head, reviewer, session: `reviewer-session-${index}`, file: files[lane] });
  }
  onBoard(box, board => store.setLineSetting(board, { agentId: 'coordinator', key: 'landingBatchSize', value: 1,
    reason: 'Batch size stays one', window: { windowMinutes: 60, activeReviewers: 2, reviewWaitMedianMinutes: 40 } }));
  return { box, items };
}

/**
 * Accept in the reviewer's own session, outside the main checkout. The time kept is when the ACCEPT command started,
 * so the measured wait to the landing's start is never shorter than the real one.
 *
 * @param {object} box - The e2e project box.
 * @param {object} item - The fixture item.
 * @returns {Promise<{ acceptedAt: number }>}
 */
async function accept(box, item) {
  const acceptedAt = Date.now();
  // Process-level: the accept's wall-clock budget covers the detached automatic lander it starts, so it stays a real process.
  const result = await runFixtureChildAsync(process.execPath, [BIN, 'verify', String(item.id), 'accept', '--note', 'Read the diff and ran its frozen check.'],
    { cwd: item.reviewer, env: sessionEnv(box, item.session), stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { acceptedAt };
}

/**
 * Wait until the item records merged, then return the runner land job that landed it.
 * Why: under pull dispatch an ACCEPT offers a land job the loopback local runner lands; its receipt marks the item merged [P7,#6577].
 *
 * @param {object} box - The e2e project box.
 * @param {object} item - The fixture item.
 * @returns {Promise<object>}
 */
async function landedJob(box, item) {
  await waitForCondition(() => onBoard(box, board => Boolean(store.getItem(board, item.id).item_merged_commit)),
    `the runner land job lands #${item.id}`, {
      signal: AbortSignal.timeout(150_000),
      state: () => ({ item: onBoard(box, board => store.getItem(board, item.id).item_status), jobs: landJobs(box) }),
    });
  const job = landJobs(box).find(entry => entry.items.includes(item.id) && entry.receipt?.outcome === 'landed');
  assert.ok(job, `a landed land job carries #${item.id}`);
  return job;
}

/**
 * Prove one accepted item landed alone, started within the bar, and recorded merged on main.
 *
 * @param {object} box - The e2e project box.
 * @param {object} item - The fixture item.
 * @param {object} job - The land job that landed it.
 * @param {number} acceptedAt - When its ACCEPT was made.
 * @returns {number} how long after the ACCEPT the landing started, in ms
 */
function assertLandedAlone(box, item, job, acceptedAt) {
  assert.deepEqual(job.items, [item.id], `#${item.id} lands alone, in a land job of one`);
  const startedMs = job.claimedAt - acceptedAt;
  assert.ok(startedMs <= START_WITHIN_MS, `#${item.id}'s landing started ${startedMs} ms after its ACCEPT; the bar is ${START_WITHIN_MS} ms`); // budget: declared ceiling of the frozen bar, within 60 s of an ACCEPT
  const merged = onBoard(box, board => store.getItem(board, item.id).item_merged_commit);
  assert.match(merged ?? '', /^[0-9a-f]{40}$/u, `#${item.id} records merged`);
  box.git(box.repo, 'merge-base', '--is-ancestor', merged, 'main');
  assert.equal(box.git(box.repo, 'show', `main:${item.file}`).trim(), 'built');
  return startedMs;
}

test('clause 1: within 60 s of an ACCEPT the automatic lander starts that item\'s landing alone, with no cadence wait, and records merged [C7]', { timeout: 360_000 }, async t => { // budget: two real accept-to-merged landings in a private repo; hang ceiling, not speed.
  const { box, items } = await fixture(t);
  const [first, second] = items;

  const one = await accept(box, first);
  const firstJob = await landedJob(box, first);
  t.diagnostic(`first landing started ${assertLandedAlone(box, first, firstJob, one.acceptedAt)} ms after its ACCEPT`);
  assert.equal(onBoard(box, board => store.getItem(board, second.id).item_merged_commit), null, 'the unaccepted item waits');

  assert.equal(cadenceApplies({ automatic: true }), false, 'an accept\'s automatic landing never waits on it');
  assert.equal(cadenceApplies({ automatic: true, due: true }), true, 'a due landing keeps its queue cadence');
  assert.equal(cadenceApplies({}), true, 'a hand landing keeps its cadence');

  const two = await accept(box, second);
  const secondJob = await landedJob(box, second);
  assert.notEqual(secondJob.id, firstJob.id, 'the second accept gets its own landing');
  t.diagnostic(`second landing started ${assertLandedAlone(box, second, secondJob, two.acceptedAt)} ms after its ACCEPT, inside the cadence`);
});
