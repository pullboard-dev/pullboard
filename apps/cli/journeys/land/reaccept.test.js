/** An item reopened for a trunk conflict, merged with main and accepted again by its gate is offered a land job and lands [C7,#7948]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { provideLandingStart } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { startReceiptLanding } from '../../src/io/commands/serve.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { acceptGated } from '../../tests/fixtures/pull.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';

// Budget: hang ceiling for one project, two pulled gates and one runner landing.
const JOURNEY_MS = 300_000;
const FILE = 'web/shared.txt';

/** Run a board command at `cwd` and require it to succeed, keeping its output on failure. */
async function ok(box, cwd, ...args) {
  const ran = await box.runLocal(cwd, ...args);
  assert.equal(ran.code, 0, `${args.join(' ')}\n${ran.out}\n${ran.err}`);
  return ran;
}

/** The open land jobs that name item `id`. */
function landJobsFor(board, id) {
  return jobsOf(board.db, { kind: 'land' }).filter(job => job.step !== 'done' && job.steps.find(step => step.name === 'offered')?.payload?.payload?.items?.some(entry => entry.id === id));
}

/**
 * The 0.9.4 upgrade trial's check 11 on a fresh board: #1 is accepted, trunk moves with a conflicting change to its
 * file, the coordinator reopens it with --conflict, the builder merges main and resubmits, and the pulled gate's
 * receipt carries the accept (merge-only-accept). Returns the box, its job queue and the resolved commit.
 */
async function reacceptedItem(t) {
  const box = await pullProject(t, 1);
  const trunk = join(box.dir, 'trunk.git');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false }, trunk: { remote: trunk } }, null, 2) + '\n');
  box.git(box.repo, 'commit', '-q', '-am', 'chore: the board lands accepted items onto its trunk remote [G1]');
  box.git(box.dir, 'clone', '-q', '--bare', box.repo, trunk);
  const [id] = box.ids;
  const queue = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const first = submitOne(box, id, { path: FILE, body: 'item line\n', subject: `feat(web): item ${id} writes the shared file [G1]` });
  assert.equal((await serveOnce(box, queue.url, 'r-gate-1')).code, 0);
  assert.equal(getItem(queue.board, id).item_status, 'submitted', 'the first pulled gate put the item in review');
  acceptGated(queue.board, box.repo, id, first.commit);
  // Trunk moves with another change to the same file, as #3 landing did in the trial; nothing has landed #1 yet.
  assert.equal(box.helpers.commitFile(box, box.repo, FILE, 'trunk line\n', 'feat(web): trunk writes the shared file [G1]').status, 0);
  box.git(box.repo, 'push', '-q', trunk, 'main');
  await ok(box, box.repo, 'reopen', String(id), '--conflict', FILE);
  const claimed = await ok(box, box.web, 'claim', String(id), '--json');
  const folder = JSON.parse(claimed.out).itemFolder ?? box.web;
  assert.notEqual(box.tryGit(folder, 'merge', '-q', '--no-edit', 'main').status, 0, 'merging main conflicts');
  assert.equal(box.helpers.commitFile(box, folder, FILE, 'item line\ntrunk line\n', `fix(web): resolve the trunk merge for ${id} [G1]`).status, 0);
  const resolved = box.git(folder, 'rev-parse', 'HEAD');
  await ok(box, folder, 'submit', String(id));
  return { box, queue, id, trunk, resolved };
}

/** Serve the resubmit's pulled gate and require the receipt to carry the accept. */
async function carry({ box, queue, id, resolved }) {
  assert.equal((await serveOnce(box, queue.url, 'r-gate-2')).code, 0);
  const item = getItem(queue.board, id);
  assert.equal(item.item_status, 'verified', 'the green gate carried the accept');
  assert.equal(item.item_commit, resolved);
  assert.ok(events(queue.board, { itemId: id }).some(event => event.event_kind === 'merge-only-accept'), 'the carry is recorded');
}

test('clause 1: an item reopened with --conflict, merged with main, resubmitted and accepted again gets a land job and lands on main [C7,#7948]', { timeout: JOURNEY_MS }, async t => {
  const state = await reacceptedItem(t);
  const { box, queue, id, trunk, resolved } = state;
  // The board host's serve provides the start; here it runs the same starter in this process with the box's environment.
  provideLandingStart(request => captureCommandInProcess(async () => { await startReceiptLanding(request); return 0; }, [], { cwd: box.repo, env: box.env }));
  t.after(() => provideLandingStart(null));
  await carry(state);
  await waitForCondition(() => landJobsFor(queue.board, id).length === 1, `the carried accept offers #${id} a land job`, { signal: AbortSignal.timeout(60_000) });
  const served = await serveOnce(box, queue.url, 'r-land');
  assert.equal(served.code, 0, served.output);
  const item = getItem(queue.board, id);
  assert.ok(item.item_merged_commit, `#${id} landed: ${served.output}`);
  const tip = box.git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
  assert.equal(box.tryGit(box.dir, '--git-dir', trunk, 'merge-base', '--is-ancestor', resolved, tip).status, 0, 'trunk holds the resolved commit');
});

test('clause 2: while the re-accepted item waits, land and resume --diagnostics name its real state and next step, never BOARD_LANDS_ACCEPTED with no job [C7,#7948]', { timeout: JOURNEY_MS }, async t => {
  const state = await reacceptedItem(t);
  const { box, queue, id } = state;
  // No starter is provided, so the carried accept is left with no land job, as the trial saw it.
  provideLandingStart(null);
  await carry(state);
  assert.equal(landJobsFor(queue.board, id).length, 0, 'no land job was offered');
  const before = await box.runLocal(box.repo, 'resume', '--diagnostics');
  assert.equal(before.code, 0, before.err);
  assert.match(before.out, new RegExp(`landing: #${id} .*no land job names it; next: pullboard land offers it`, 'u'), before.out);
  assert.match(before.out, /^next: pullboard land /mu, before.out);
  const land = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(land.code, 0, `land offers the missing job: ${land.out}\n${land.err}`);
  const [job] = landJobsFor(queue.board, id);
  assert.ok(job, 'land offered the job the accept never got');
  assert.equal(JSON.parse(land.out).offered, job.id);
  const again = await box.runLocal(box.repo, 'land', '--json');
  const error = JSON.parse(again.out)?.error;
  assert.equal(error?.code, 'BOARD_LANDS_ACCEPTED', again.out + again.err);
  assert.match(error.message, new RegExp(`#${id} waits in land job ${job.id.replace(/[+]/gu, '\\+')} \\(offered`, 'u'), 'the refusal names the job that holds it');
  const after = await box.runLocal(box.repo, 'resume', '--diagnostics');
  assert.match(after.out, new RegExp(`landing: #${id} .*waits in land job ${job.id.replace(/[+]/gu, '\\+')}`, 'u'), after.out);
  assert.doesNotMatch(after.out, /^next: merge #/mu, 'the next step is not a hand merge while the board lands it');
});
