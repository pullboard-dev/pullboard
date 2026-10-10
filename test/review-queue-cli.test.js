/** Real CLI and authenticated API review suggestions preserve explicit build and review intent [Q1,V15,A1,A2]. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { main } from '../src/cli.js';
import { serveApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { fetchFresh } from './http-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const HOUR = 3_600_000;

/** Capture the actual CLI with a deterministic board clock and one JSON result. */
async function run(box, cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd, clock: box.clock,
    stdout: { isTTY: false, write: (part) => { stdout += part; } },
    stderr: { write: (part) => { stderr += part; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

/** Create an isolated real repo, two joined builders, a reviewer and source-backed claim policy. */
async function project(t, ratio = 3) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-review-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });
  let at = Date.parse('2026-10-08T12:00:00.000Z');
  const clock = { now: () => new Date(at), advance: (ms) => { at += ms; } };
  const box = { root, dir, clock, git };
  git(root, 'init', '-q', '-b', 'main');
  const initialized = await run(box, root, ['init', '--json']);
  assert.equal(initialized.code, 0, initialized.stderr);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: { reviewRatio: ratio },
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, review: { owns: [], specs: ['G1'] } }, shared: [] }));
  writeFileSync(join(root, 'SPEC.md'), '# Review fixture\n## G\n- G1 [approved, must] Every move keeps its evidence. | gate: true\n');
  writeFileSync(join(root, loadConfig(root).practice), '');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'chore: initialize review fixture');
  box.builder = join(dir, 'builder'); box.peer = join(dir, 'peer'); box.reviewer = join(dir, 'reviewer'); box.reviewer2 = join(dir, 'reviewer-two');
  for (const [path, branch] of [[box.builder, 'web/one'], [box.peer, 'web/two'], [box.reviewer, 'review/one'], [box.reviewer2, 'review/two']]) {
    git(root, 'worktree', 'add', '-q', path, '-b', branch);
  }
  box.board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(box.board));
  box.builderId = store.register(box.board, { lane: 'web', path: box.builder });
  box.peerId = store.register(box.board, { lane: 'web', path: box.peer });
  box.reviewerId = store.register(box.board, { lane: 'review', path: box.reviewer });
  box.reviewer2Id = store.register(box.board, { lane: 'review', path: box.reviewer2 });
  return box;
}

/** Add a genuine private submitted item with append-only events and stable fake Git receipts. */
function submitted(box, builder = box.peerId) {
  const id = store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Review waiting', specs: 'G1', criterion: 'The move keeps evidence.', check: 'true' });
  const text = JSON.stringify({ rows: [{ id: 'G1', text: 'Every move keeps its evidence.', gate: 'true' }] });
  store.claim(box.board, id, { agentId: builder, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text, digest: createHash('sha256').update(text).digest('hex') }) });
  store.submit(box.board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
  return id;
}

/** Create the source-cited build that ordinary next would claim. */
function build(box, check = undefined) {
  return store.addItem(box.board, { by: 'coordinator', lane: 'web', title: 'Available build', specs: 'G1', criterion: 'The move keeps evidence.', check });
}

test('[Q1,V15] next offers before a new claim, --build records the skip, and held claims renew normally', async (t) => {
  const box = await project(t);
  const ids = [submitted(box), submitted(box), submitted(box)];
  const id = build(box);
  const before = store.events(box.board).length;
  const offered = await run(box, box.builder, ['next', '--json']);
  assert.equal(offered.code, 0, offered.stderr);
  assert.ok(offered.data.offer, 'next produces a review offer before claiming');
  assert.ok(ids.includes(offered.data.offer.item));
  assert.equal(offered.data.offer.command, `pullboard next --verify ${offered.data.offer.item}`);
  assert.equal(offered.data.build.item_id, id);
  assert.equal(offered.data.review, true);
  assert.equal(store.events(box.board).length, before, 'a suggestion emits no move');
  assert.equal(store.getItem(box.board, id).item_status, 'open');
  assert.equal(store.getItem(box.board, offered.data.offer.item).item_review_by, null, 'offering does not reserve');
  const prose = await run(box, box.builder, ['next']);
  assert.match(prose.stdout, /ratio 3 reached/u);
  assert.ok(prose.stdout.indexOf('review offered:') < prose.stdout.indexOf('build available:'), 'review appears first');
  const claimed = await run(box, box.builder, ['next', '--build', '--json']);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(claimed.data.item.item_id, id);
  assert.equal(claimed.data.item.item_status, 'claimed');
  const detail = JSON.parse(store.events(box.board, { itemId: id }).at(-1).event_detail);
  assert.ok(detail.reviewSkipped, 'the explicit build claim records the offered review');
  assert.equal(detail.reviewSkipped.offeredItem, offered.data.offer.item);
  assert.equal(detail.reviewSkipped.pending, 3);
  assert.equal(detail.reviewSkipped.ratio, 3);
  const renewal = await run(box, box.builder, ['next', '--json']);
  assert.equal(renewal.code, 0, renewal.stderr);
  assert.equal(renewal.data.held, true);
  assert.equal(renewal.data.offer, undefined);
  assert.equal(JSON.parse(store.events(box.board, { itemId: id }).at(-1).event_detail).reviewSkipped, undefined);
  const invalid = await run(box, box.builder, ['next', '--build', '--verify', '--json']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.data.error.code, 'USAGE');
});

test('[Q1,V15,A1] below the configured ratio next claims normally and status reports submit age', async (t) => {
  const box = await project(t, 4);
  submitted(box); submitted(box); submitted(box);
  const id = build(box);
  box.clock.advance(2 * HOUR);
  const status = await run(box, box.builder, ['status', '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(status.data.reviewQueue, { pending: 3, reviewing: 0, reserved: 0,
    oldestSubmittedAt: '2026-10-08T12:00:00.000Z', ageMs: 2 * HOUR,
    awaitingFirstReview: 3, releasedWithoutVerdict: 0, releasedItems: [] });
  const prose = await run(box, box.builder, ['status']);
  assert.match(prose.stdout, /review queue: 3 submitted; 3 waiting for a first reviewer, 0 released without a verdict, 0 agents reviewing; oldest submission 2h ago/u);
  const claimed = await run(box, box.builder, ['next', '--json']);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(claimed.data.item.item_id, id);
  assert.equal(claimed.data.offer, undefined);
  assert.equal(JSON.parse(store.events(box.board, { itemId: id }).at(-1).event_detail).reviewSkipped, undefined);
});

test('[V1,R1] a review released without a verdict waits an hour for the same reviewer and resets on resubmit', async (t) => {
  const box = await project(t);
  const released = submitted(box);
  const firstReview = submitted(box);
  const initial = await run(box, box.reviewer, ['next', '--verify', String(released), '--json']);
  assert.equal(initial.code, 0, initial.stderr);
  assert.equal(initial.data.item.item_id, released);

  const beforeMissingNote = store.events(box.board, { itemId: released }).length;
  const missingNote = await run(box, box.reviewer, ['release', String(released), '--json']);
  assert.equal(missingNote.code, 1);
  assert.equal(missingNote.data.error.code, 'NOTE_REQUIRED');
  assert.match(missingNote.data.error.message, /one-line reason with --note/u);
  assert.equal(store.getItem(box.board, released).item_review_by, box.reviewerId, 'a refused release keeps its reservation');
  assert.equal(store.events(box.board, { itemId: released }).length, beforeMissingNote, 'a refusal appends no release event');

  const multiline = await run(box, box.reviewer, ['release', String(released), '--note', 'first line\nsecond line', '--json']);
  assert.equal(multiline.code, 1);
  assert.equal(multiline.data.error.code, 'NOTE_REQUIRED', 'the recorded reason must be one line');
  const releasedResult = await run(box, box.reviewer, ['release', String(released), '--note', 'checked the wrong tree', '--json']);
  assert.equal(releasedResult.code, 0, releasedResult.stderr);
  const releaseEvent = store.events(box.board, { itemId: released }).at(-1);
  assert.equal(releaseEvent.event_kind, 'release');
  assert.deepEqual(JSON.parse(releaseEvent.event_detail), { review: true, reason: 'checked the wrong tree' });
  const secondReservation = await run(box, box.builder, ['next', '--verify', String(released), '--json']);
  assert.equal(secondReservation.code, 0, secondReservation.stderr);
  assert.equal(secondReservation.data.item.item_id, released);
  const secondRelease = await run(box, box.builder, ['release', String(released), '--note', 'confirmed the wrong tree was reviewed']);
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
  store.verify(box.board, released, { agentId: box.reviewer2Id, decision: 'REJECT', reason: 'OTHER', note: 'private fixture rework',
    head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' });
  const rejectedReserve = await run(box, box.builder, ['next', '--verify', String(released), '--json']);
  assert.equal(rejectedReserve.code, 1);
  assert.equal(rejectedReserve.data.error.code, 'NOT_SUBMITTED', 'an old cooldown must not mask the item-state refusal');
  store.claim(box.board, released, { agentId: box.peerId, lane: 'web', leaseMs: HOUR,
    freeze: (current) => ({ text: current.item_frozen, digest: current.item_frozen_digest }) });
  store.submit(box.board, released, { agentId: box.peerId, commit: createHash('sha1').update('resubmitted review item').digest('hex'),
    tree: createHash('sha1').update('resubmitted review tree').digest('hex') });
  const afterResubmit = await run(box, box.reviewer, ['next', '--verify', String(released), '--json']);
  assert.equal(afterResubmit.code, 0, afterResubmit.stderr);
  assert.equal(afterResubmit.data.item.item_id, released, 'a new submission clears the previous release cooldown');

  const hourBoundary = submitted(box);
  const reserveBoundary = await run(box, box.reviewer, ['next', '--verify', String(hourBoundary), '--json']);
  assert.equal(reserveBoundary.code, 0, reserveBoundary.stderr);
  const releaseBoundary = await run(box, box.reviewer, ['release', String(hourBoundary), '--note', 'checking the submission again']);
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

test('[Q1,V15,A2] authenticated API next returns a real unreserved offer and explicit build keeps the claim contract', async (t) => {
  const box = await project(t);
  submitted(box); submitted(box); submitted(box);
  const id = build(box);
  const apiKey = randomUUID();
  const api = await serveApi({ secret: apiKey, projects: () => [{ root: box.root }],
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
  const before = store.events(box.board).length;
  const offered = await next({});
  assert.ok(offered.offer, 'the HTTP success contains its unreserved offer');
  assert.equal(offered.event, null);
  assert.equal(offered.offer.command, `pullboard next --verify ${offered.offer.item}`);
  assert.equal(offered.result.offer.item, offered.offer.item);
  assert.equal(store.events(box.board).length, before);
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
  const ran = await run(box, box.builder, ['run', '--agent', 'true', '--items', '1', '--attempts', '1', '--minutes', '1']);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(store.getItem(box.board, id).item_status, 'submitted', ran.stdout);
  assert.match(ran.stdout, /runner done: 1 submitted, 0 escalated/u);
  assert.equal(ran.stdout.match(/review backlog:/gu)?.length, 1, 'one iteration prints one backlog notice');
  assert.match(ran.stdout, /review backlog: 3 awaiting, 0 agents reviewing/u);
  const claim = store.events(box.board, { itemId: id }).find((event) => event.event_kind === 'claim');
  const skipped = JSON.parse(claim.event_detail).reviewSkipped;
  assert.equal(skipped.pending, 3);
  assert.ok(Number.isSafeInteger(skipped.offeredItem));
  assert.equal(store.listItems(box.board).some((item) => item.item_review_by === box.builderId), false, 'the runner reserves no review');
});
