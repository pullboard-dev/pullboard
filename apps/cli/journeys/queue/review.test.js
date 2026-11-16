import { viewApiPorts } from '../../../view/index.js';
/** Real CLI and authenticated API review suggestions preserve explicit build and review intent [Q1,V15,A1,A2]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { journeyCall } from '../../tests/fixtures/e2e.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { fetchFresh } from '../../tests/fixtures/http.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const HOUR = 3_600_000;
/** An agent that writes a change in its lane; the runner commits it, and a submit with no change is refused (EMPTY_SUBMIT). */
const COMMITTING_AGENT = "sh -c 'mkdir -p web && echo built > web/built.txt'";

/**
 * Capture the actual CLI with a deterministic board clock and one JSON result, in this process; under PULLBOARD_JOURNEY_MODE=process
 * the same call runs as a real process (which keeps the real clock) so the gate's parity check can compare the two, and each call is
 * recorded when PULLBOARD_PARITY_RECORD is set [C7].
 */
async function run(box, cwd, args) {
  const answer = await journeyCall({ dir: box.dir, env: box.env, cwd, args: [...args], bin: BIN, inProcess: async () => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { cwd, clock: box.clock,
      stdout: { isTTY: false, write: (part) => { stdout += part; } },
      stderr: { write: (part) => { stderr += part; } } });
    return { status: code, stdout, stderr };
  } });
  return { code: answer.status, stdout: answer.stdout, stderr: answer.stderr, data: args.includes('--json') ? JSON.parse(answer.stdout) : null };
}

/** Create an isolated real repo, two joined builders (unrouted items are strong, so every seat joins strong), a reviewer and source-backed claim policy. */
async function project(t, ratio = 3) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-review-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const root = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(root); mkdirSync(bin);
  /** Quote a literal executable path for the private hook shim. */
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Review fixture', GIT_AUTHOR_EMAIL: 'review@example.invalid',
    GIT_COMMITTER_NAME: 'Review fixture', GIT_COMMITTER_EMAIL: 'review@example.invalid' };
  /** Execute private Git commands with synthetic identity and the actual hook shim. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });
  let at = Date.parse('2026-10-08T12:00:00.000Z');
  const clock = { now: () => new Date(at), advance: (ms) => { at += ms; } };
  const box = { root, dir, clock, git, bin, env };
  git(root, 'init', '-q', '-b', 'main');
  // The unattended runner pins attempts with Git from the process environment, which carries no identity.
  git(root, 'config', 'user.name', 'Review fixture'); git(root, 'config', 'user.email', 'review@example.invalid');
  const initialized = await run(box, root, ['init', '--json']);
  assert.equal(initialized.code, 0, initialized.stderr);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: { reviewRatio: ratio },
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, review: { owns: [], specs: ['G1'] } }, shared: [] }));
  writeFileSync(join(root, 'SPEC.md'), '# Review fixture\n## G\n- G1 [approved, must] Every move keeps its evidence. | gate: true\n');
  writeFileSync(join(root, loadConfig(root).practice), '');
  git(root, 'add', '-A'); git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'chore: initialize review fixture'); // setup only: no hook starts a node child
  box.builder = join(dir, 'builder'); box.peer = join(dir, 'peer'); box.reviewer = join(dir, 'reviewer'); box.reviewer2 = join(dir, 'reviewer-two');
  for (const [path, branch] of [[box.builder, 'web/one'], [box.peer, 'web/two'], [box.reviewer, 'review/one'], [box.reviewer2, 'review/two']]) {
    git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', path, '-b', branch);
  }
  box.board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(box.board));
  box.builderId = store.register(box.board, { lane: 'web', path: box.builder, route: 'strong', family: 'Fixture-Builder' });
  box.peerId = store.register(box.board, { lane: 'web', path: box.peer, route: 'strong', family: 'Fixture-Peer' });
  box.reviewerId = store.register(box.board, { lane: 'review', path: box.reviewer, route: 'strong', family: 'Fixture-Reviewer' });
  box.reviewer2Id = store.register(box.board, { lane: 'review', path: box.reviewer2, route: 'strong', family: 'Fixture-Reviewer-Two' });
  return box;
}

/** Add a genuine private submitted item with append-only events and stable fake Git receipts. */
function submitted(box, builder = box.peerId) {
  const id = store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Review waiting', specs: 'G1', criterion: 'The move keeps evidence.', check: 'true' });
  const text = JSON.stringify({ rows: [{ id: 'G1', text: 'Every move keeps its evidence.', gate: 'true' }] });
  store.claim(box.board, id, { agentId: builder, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text, digest: createHash('sha256').update(text).digest('hex') }) });
  submitFixture(box.board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  return id;
}

/** Create the source-cited build that ordinary next would claim. */
function build(box, check = undefined) {
  return store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Available build', specs: 'G1', criterion: 'The move keeps evidence.', check });
}

test('clause 2: [Q1,V15] next hands out the mandatory review before a new claim [conveyor rule: review is work next hands out]', async (t) => {
  const box = await project(t);
  const ids = [submitted(box), submitted(box), submitted(box)];
  const id = build(box);
  const handed = await run(box, box.builder, ['next', '--json']);
  assert.equal(handed.code, 0, handed.stderr);
  // A seat with no claim takes the first review before any build (ca4d88511e); plain next is the default loop.
  assert.equal(handed.data.review, true);
  assert.equal(handed.data.offer, undefined, 'a mandatory review is handed out, not offered');
  const reserved = handed.data.item.item_id;
  assert.ok(ids.includes(reserved));
  assert.equal(store.getItem(box.board, reserved).item_review_by, box.builderId, 'the review is reserved for the seat');
  assert.equal(store.getItem(box.board, id).item_status, 'open', 'the build stays unclaimed');
  const prose = await run(box, box.builder, ['next']);
  assert.match(prose.stdout, new RegExp(`next to verify: #${reserved} `, 'u'));
  assert.match(prose.stdout, /reserved for you until/u);
});

test('[Q1,V15] --build records the skipped review, and held claims renew normally', async (t) => {
  const box = await project(t);
  const ids = [submitted(box), submitted(box), submitted(box)];
  const id = build(box);
  const claimed = await run(box, box.builder, ['next', '--build', '--json']);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(claimed.data.item.item_id, id);
  assert.equal(claimed.data.item.item_status, 'claimed');
  const detail = JSON.parse(store.events(box.board, { itemId: id }).at(-1).event_detail);
  assert.ok(detail.reviewSkipped, 'the explicit build claim records the offered review');
  assert.ok(ids.includes(detail.reviewSkipped.offeredItem));
  assert.equal(detail.reviewSkipped.pending, 3);
  assert.equal(detail.reviewSkipped.ratio, 3);
  // Plain next is the default loop and hands out a review first; the explicit build renews the held claim.
  const renewal = await run(box, box.builder, ['next', '--build', '--json']);
  assert.equal(renewal.code, 0, renewal.stderr);
  assert.equal(renewal.data.held, true);
  assert.equal(renewal.data.offer, undefined);
  assert.deepEqual(JSON.parse(store.events(box.board, { itemId: id }).at(-1).event_detail).reviewSkipped, detail.reviewSkipped, 'an explicit build records the same skip again');
  const invalid = await run(box, box.builder, ['next', '--build', '--verify', '--json']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.data.error.code, 'USAGE');
});

test('[Q1,V15,A1] an explicit build below the configured ratio records the skip without an offer, and status reports submit age', async (t) => {
  const box = await project(t, 4);
  submitted(box); submitted(box); submitted(box);
  const id = build(box);
  const claimed = await run(box, box.builder, ['next', '--build', '--json']);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(claimed.data.item.item_id, id);
  assert.equal(claimed.data.offer, undefined);
  // An explicit build always records the skip; below the ratio no review was offered, so it names none.
  assert.deepEqual(JSON.parse(store.events(box.board, { itemId: id }).at(-1).event_detail).reviewSkipped,
    { ageMs: 0, offeredItem: null, oldestSubmittedAt: '2026-10-08T12:00:00.000Z', pending: 3, ratio: 4, reserved: 0, reviewing: 0 });
  const released = await run(box, box.builder, ['release', String(id), '--reason', 'BLOCKED', '--note', 'check aged review routing', '--json']);
  assert.equal(released.code, 0, released.stderr);
  assert.equal(store.getItem(box.board, id).item_status, 'open');
  box.clock.advance(2 * HOUR);
  const status = await run(box, box.builder, ['status', '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(status.data.reviewQueue, { pending: 3, reviewing: 0, reserved: 0,
    oldestSubmittedAt: '2026-10-08T12:00:00.000Z', ageMs: 2 * HOUR,
    awaitingFirstReview: 3, releasedWithoutVerdict: 0, releasedItems: [] });
  const prose = await run(box, box.builder, ['status']);
  assert.match(prose.stdout, /review queue: 3 submitted; 3 waiting for a first reviewer, 0 released without a verdict, 0 agents reviewing; oldest submission 2h ago/u);
  const aged = await run(box, box.builder, ['next', '--json']);
  assert.equal(aged.code, 0, aged.stderr);
  assert.equal(aged.data.review, true, 'a two-hour wait hands out a review');
  assert.equal(aged.data.item.item_review_by, box.builderId);
  assert.equal(store.getItem(box.board, id).item_status, 'open', 'the aged review does not claim the build');
});

test('[V1,R1] a review released without a verdict waits an hour for the same reviewer and resets on resubmit', async (t) => {
  const box = await project(t);
  const released = submitted(box);
  const firstReview = submitted(box);
  const initial = await run(box, box.reviewer, ['next', '--verify', String(released), '--json']);
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(initial.data.item.item_id, released);

  const beforeMissingNote = store.events(box.board, { itemId: released }).length;
  const missingNote = await run(box, box.reviewer, ['release', String(released), '--reason', 'BLOCKED', '--json']);
  assert.equal(missingNote.code, 1);
  assert.equal(missingNote.data.error.code, 'NOTE_REQUIRED');
  assert.match(missingNote.data.error.message, /one-line reason with --note/u);
  assert.equal(store.getItem(box.board, released).item_review_by, box.reviewerId, 'a refused release keeps its reservation');
  assert.equal(store.events(box.board, { itemId: released }).length, beforeMissingNote, 'a refusal appends no release event');

  const multiline = await run(box, box.reviewer, ['release', String(released), '--reason', 'BLOCKED', '--note', 'first line\nsecond line', '--json']);
  assert.equal(multiline.code, 1);
  assert.equal(multiline.data.error.code, 'NOTE_REQUIRED', 'the recorded reason must be one line');
  const releasedResult = await run(box, box.reviewer, ['release', String(released), '--reason', 'BLOCKED', '--note', 'checked the wrong tree', '--json']);
  assert.equal(releasedResult.code, 0, releasedResult.stderr);
  const releaseEvent = store.events(box.board, { itemId: released }).at(-1);
  assert.equal(releaseEvent.event_kind, 'release');
  assert.deepEqual(JSON.parse(releaseEvent.event_detail), { review: true, reason: 'checked the wrong tree', reasonCode: 'BLOCKED', model: 'unknown' });
  const secondReservation = await run(box, box.builder, ['next', '--verify', String(released), '--json']);
  assert.equal(secondReservation.code, 0, secondReservation.stderr);
  assert.equal(secondReservation.data.item.item_id, released);
  const secondRelease = await run(box, box.builder, ['release', String(released), '--reason', 'BLOCKED', '--note', 'confirmed the wrong tree was reviewed']);
  assert.equal(secondRelease.code, 0, secondRelease.stderr);

  const status = await run(box, box.reviewer, ['status', '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(
    [status.data.reviewQueue.pending, status.data.reviewQueue.awaitingFirstReview, status.data.reviewQueue.releasedWithoutVerdict],
    [2, 1, 1],
    'released submissions are separate from items awaiting their first review',
  );
  assert.deepEqual(status.data.reviewQueue.releasedItems, [
    { item: released, releases: 2, reason: 'confirmed the wrong tree was reviewed' },
  ], 'status identifies the item, cumulative release count, and latest reason');
  const statusText = await run(box, box.reviewer, ['status']);
  assert.match(statusText.stdout, new RegExp(`review queue: 2 submitted; 1 waiting for a first reviewer, 1 released without a verdict \\(#${released} released 2 times: confirmed the wrong tree was reviewed\\), 0 agents reviewing`, 'u'));

  const sameReviewer = await run(box, box.reviewer, ['next', '--verify', '--json']);
  assert.equal(sameReviewer.code, 0, sameReviewer.stderr);
  assert.equal(sameReviewer.data.item.item_id, firstReview, 'the same reviewer is offered other eligible work first');
  const anotherReviewer = await run(box, box.reviewer2, ['next', '--verify', '--json']);
  assert.equal(anotherReviewer.code, 0, anotherReviewer.stderr);
  assert.equal(anotherReviewer.data.item.item_id, released, 'another reviewer may take the released submission');

  const item = store.getItem(box.board, released);
  store.verify(box.board, released, { agentId: box.reviewer2Id, decision: 'REJECT', reason: 'OTHER', note: 'private fixture rework', clause: 'Every move keeps its evidence.',
    head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' });
  const rejectedReserve = await run(box, box.builder, ['next', '--verify', String(released), '--json']);
  assert.equal(rejectedReserve.code, 1);
  assert.equal(rejectedReserve.data.error.code, 'NOT_SUBMITTED', 'an old cooldown must not mask the item-state refusal');
  store.claim(box.board, released, { agentId: box.peerId, lane: 'web', leaseMs: HOUR,
    freeze: (current) => ({ text: current.item_frozen, digest: current.item_frozen_digest }) });
  submitFixture(box.board, released, { agentId: box.peerId, commit: createHash('sha1').update('resubmitted review item').digest('hex'),
    tree: createHash('sha1').update('resubmitted review tree').digest('hex') });
  const afterResubmit = await run(box, box.reviewer, ['next', '--verify', String(released), '--json']);
  assert.equal(afterResubmit.code, 0, afterResubmit.stderr);
  assert.equal(afterResubmit.data.item.item_id, released, 'a new submission clears the previous release cooldown');

  const hourBoundary = submitted(box);
  const reserveBoundary = await run(box, box.reviewer, ['next', '--verify', String(hourBoundary), '--json']);
  assert.equal(reserveBoundary.code, 0, reserveBoundary.stderr);
  const releaseBoundary = await run(box, box.reviewer, ['release', String(hourBoundary), '--reason', 'BLOCKED', '--note', 'checking the submission again']);
  assert.equal(releaseBoundary.code, 0, releaseBoundary.stderr);
  box.clock.advance(HOUR - 1);
  const tooSoon = await run(box, box.reviewer, ['next', '--verify', String(hourBoundary), '--json']);
  assert.equal(tooSoon.code, 1);
  assert.equal(tooSoon.data.error.code, 'REVIEW_COOLDOWN');
  box.clock.advance(1);
  const afterHour = await run(box, box.reviewer, ['next', '--verify', String(hourBoundary), '--json']);
  assert.equal(afterHour.code, 0, afterHour.stderr);
  assert.equal(afterHour.data.item.item_id, hourBoundary, 'the original reviewer is eligible at exactly one hour');
});

test('[Q1,V15,A2] authenticated API next hands out the mandatory review and explicit build keeps the claim contract', async (t) => {
  const box = await project(t);
  submitted(box); submitted(box); submitted(box);
  const id = build(box);
  const apiKey = randomUUID();
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: apiKey, projects: () => [{ root: box.root }],
    runCommand: (args, io) => main(args, { ...io, clock: box.clock }) });
  t.after(() => api.close());
  const boardId = store.boardId(box.board);
  /** Send one bounded authenticated move through the real local HTTP adapter, on its own connection. */
  async function next(args) {
    const response = await fetchFresh(`${new URL(api.url).origin}/api/v1/boards/${boardId}/moves`, { method: 'POST',
      headers: { 'x-pullboard-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'next', agent: box.builderId, args }), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const offered = await next({});
  // Review is work next hands out: with the ratio reached and no claim, the mandatory first review is reserved (ca4d88511e).
  assert.equal(offered.offer, undefined, 'the HTTP success hands out the review rather than offering it');
  assert.equal(offered.result.review, true);
  assert.equal(offered.result.item.item_review_by, box.builderId);
  assert.equal(store.getItem(box.board, offered.result.item.item_id).item_review_by, box.builderId);
  assert.equal(store.getItem(box.board, id).item_status, 'open');
  const claimed = await next({ build: true });
  assert.equal(claimed.event.event_kind, 'claim');
  assert.equal(claimed.event.item_id, id);
  assert.equal(claimed.result.item.item_status, 'claimed');
  assert.equal(claimed.offer, undefined);
});

test('[Q1,V15,N14] the unattended runner keeps building and records its review backlog once per iteration', async (t) => {
  const box = await project(t);
  submitted(box); submitted(box); submitted(box);
  const id = build(box, 'true');
  // The runner commits in this process, so the repo's hooks find the pullboard launcher on PATH.
  const path = process.env.PATH;
  process.env.PATH = `${box.bin}:${path}`;
  t.after(() => { process.env.PATH = path; });
  const ran = await run(box, box.builder, ['run', '--agent', COMMITTING_AGENT, '--items', '1', '--attempts', '1', '--minutes', '1']);
  assert.equal(ran.code, 0, ran.stderr);
  // Pull dispatch settles the gate on a runner after this command returns, so the item is submitted or already queued in its gate.
  assert.ok(store.getItem(box.board, id).item_status === 'submitted' || /#\d+ is in the gate as job /u.test(ran.stdout), ran.stdout);
  assert.match(ran.stdout, /runner done: 1 submitted, 0 escalated/u);
  assert.equal(ran.stdout.match(/review backlog:/gu)?.length, 1, 'one iteration prints one backlog notice');
  assert.match(ran.stdout, /review backlog: 3 awaiting, 0 agents reviewing/u);
  const claim = store.events(box.board, { itemId: id }).find((event) => event.event_kind === 'claim');
  const skipped = JSON.parse(claim.event_detail).reviewSkipped;
  assert.equal(skipped.pending, 3);
  assert.ok(Number.isSafeInteger(skipped.offeredItem));
  assert.equal(store.listItems(box.board).some((item) => item.item_review_by === box.builderId), false, 'the runner reserves no review');
});

test('[N2,B13,H16] plain next follows recorded line capacity without a reviewer role flag', async t => {
  const box = await project(t, 99);
  const ids = Array.from({ length: 5 }, () => submitted(box));
  const id = build(box);
  for (const [key, value] of [['reviewsFirst', true], ['wipPerReviewer', 1.5]]) {
    store.setLineSetting(box.board, { agentId: 'coordinator', key, value, reason: 'private five-item capacity window', window: { activeReviewers: 1 } });
  }
  const offered = await run(box, box.builder, ['next', '--json']);
  assert.equal(offered.code, 0, offered.stderr);
  assert.equal(offered.data.review, true);
  // Recorded line capacity makes the review mandatory, and next hands it out reserved (ca4d88511e).
  assert.equal(offered.data.offer, undefined);
  assert.ok(ids.includes(offered.data.item.item_id));
  assert.equal(offered.data.item.item_review_by, box.builderId);
  assert.equal(store.getItem(box.board, id).item_status, 'open');
  const refused = await run(box, box.builder, ['claim', String(id), '--json']);
  assert.equal(refused.code, 1);
  assert.equal(refused.data.error.code, 'LINE_WIP_LIMIT');
  // The seat holds the oldest review, so the message names the oldest one still waiting.
  assert.match(refused.data.error.message, new RegExp(`#${ids[1]}`));
});
