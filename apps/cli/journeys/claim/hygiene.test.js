/** Build claims stay alive only on real work; idle and waiting claims free their seat on their own [B4,B5,B13]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { saveAgentSession } from '../../../../packages/seats/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { readActivityDelivery } from '../../../../packages/activity/index.js';
import { itemProgress } from '../../../../packages/roadmap/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { counterProofStats } from '../../../../packages/verify/index.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { staleStateSnapshot } from '../../../../packages/health/index.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { itemById } from '../../../../packages/store/index.js';
import { work } from '../../../../packages/seats/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
for (const key of Object.keys(ENV)) if (key.startsWith('GIT_') && !/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(key)) delete ENV[key];

/** A real repository with one worktree per seat, an in-memory board on a clock the test advances, and a private machine home. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-claim-hygiene-')));
  const previousHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: ENV });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: base');
  const base = git(repo, 'rev-parse', 'HEAD');
  let at = Date.now() + 60_000;
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: repo });
  const worktrees = {};
  /** Join a seat in its own real worktree, under the named runtime session. */
  const seat = (name, session) => {
    const path = join(dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    const id = store.register(board, { lane: 'core', path, route: 'strong' });
    saveAgentSession(board, id, session.repeat(64));
    worktrees[id] = path;
    return id;
  };
  const first = seat('first', '1'), second = seat('second', '3'), helper = seat('helper', '2');
  const add = (after = []) => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Work', criterion: 'Real proof', specIds: ['B5'], route: 'strong', check: 'true', after });
  const claim = (id, agentId, submitOutcome = null) => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000, head: base, submitOutcome,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, rows: [], policy: { version: 1, commit: base, verify: { policy: 'any', family: 'off' } } }), digest: 'bar' }) });
  const ctx = { clock: { now: () => new Date(at) }, config: {} };
  /** One ordinary write by another seat runs the same maintenance every board write runs. */
  const maintain = (actor = helper) => {
    const snapshot = captureLapsedClaims(ctx, board, actor);
    if (snapshot) store.maintainStaleState(board, { agentId: actor, snapshot, health: {}, claimsOnly: true });
    return snapshot;
  };
  /** A real file change in a seat's worktree, stamped at the board clock. */
  const touch = (agent, file) => {
    writeFileSync(join(worktrees[agent], file), `${at}\n`);
    utimesSync(join(worktrees[agent], file), new Date(at), new Date(at));
  };
  const health = id => staleStateSnapshot(board, {}, { now: new Date(at), items: [store.getItem(board, id)], claimsOnly: true,
    workObservation: () => ({ available: true, at: null }) }).claims[0]?.health;
  return { board, git, repo, base, worktrees, first, second, helper, seat, add, claim, maintain, touch, health,
    now: () => at, advance: minutes => {
      at += minutes * 60_000;
      // A live seat keeps heartbeating while the clock moves; silence would read as a gone seat and release at once.
      for (const id of Object.keys(worktrees)) heartbeatSeat(board, id);
    } };
}

/** Events of one kind on one item. */
const kinds = (f, id, kind) => store.events(f.board, { itemId: id }).filter(event => event.event_kind === kind);

test('an idle or waiting claim goes on hold and frees the seat, and a second claim is refused [B4,B5,B13]', t => {
  const f = fixture(t);
  const a = f.add(), b = f.add();
  f.claim(a, f.first);
  assert.throws(() => f.claim(b, f.first), { code: 'ONE_CLAIM' });
  // Real work: a changed file in the builder's worktree.
  f.touch(f.first, 'work.txt');
  f.advance(20);
  f.maintain();
  assert.equal(kinds(f, a, 'claim_stalled').length, 1, 'twenty idle minutes show as stalled and tell the lead');
  const delivery = readActivityDelivery(f.board, f.first);
  const stalled = delivery.interrupts.find(entry => entry.reason === 'stalled' && entry.item === a);
  assert.ok(stalled, 'the stalled holder is notified automatically without a coordinator nudge');
  store.recordActivityDelivery(f.board, { agentId: f.first, interrupts: [stalled], through: delivery.cursor });
  assert.equal(store.activityDeliveryState(f.board, f.first).pending.find(entry => entry.id === stalled.id).reason, 'stalled');
  f.maintain();
  assert.equal(kinds(f, a, 'claim_stalled').length, 1, 'the lead is told once');
  // Renewing is not work: it neither resets the idle time nor delays the release.
  f.claim(a, f.first);
  f.advance(20);
  f.maintain();
  const released = store.getItem(f.board, a);
  assert.equal(released.item_status, 'open', 'forty idle minutes release the claim with no coordinator step');
  assert.equal(released.item_owner, null);
  assert.equal(store.itemHold(f.board, a), null, 'an idle claim returns to the queue at once');
  const detail = JSON.parse(kinds(f, a, 'release').at(-1).event_detail);
  assert.match(detail.reason, /Idle 40 minutes/u);
  assert.ok(detail.reason.includes(detail.idleClaim.handoff.pin), 'the release note keeps the work ref');
  assert.deepEqual(detail.idleClaim.handoff.changedFiles, ['work.txt']);
  assert.equal(f.git(f.repo, 'rev-parse', detail.idleClaim.handoff.pin), detail.idleClaim.handoff.head, 'the pinned ref survives the old worktree');
  f.claim(a, f.second);
  assert.equal(store.getItem(f.board, a).item_owner, f.second, 'any seat takes the released item');
  store.release(f.board, a, f.second, 'handing back', 'OTHER');

  // A claim whose item waits on an accepted but unlanded item is released and held until that item lands.
  const dependency = f.add();
  f.claim(dependency, f.helper);
  submitFixture(f.board, dependency, { agentId: f.helper, commit: f.base, tree: f.base });
  store.verify(f.board, dependency, { agentId: f.second, head: f.base, digest: 'bar', policy: 'any', decision: 'ACCEPT', note: 'fixture proof' });
  const waiting = f.add([dependency]);
  f.claim(waiting, f.first);
  assert.equal(f.health(waiting), 'waiting');
  f.maintain();
  assert.equal(store.getItem(f.board, waiting).item_status, 'open');
  assert.match(JSON.parse(kinds(f, waiting, 'release').at(-1).event_detail).reason, new RegExp(`Waiting on #${dependency}`, 'u'));
  assert.throws(() => f.claim(waiting, f.second), error => error.code === 'BLOCKED' && error.message.includes(`#${dependency}`), 'the wait holds the item');
  const beforeLanding = itemProgress(f.board, waiting);
  assert.ok(beforeLanding.waits.includes(`#${dependency}`));
  const shoutsBefore = f.board.db.prepare('SELECT COUNT(*) AS n FROM shout').get().n;
  store.merged(f.board, dependency, { agentId: 'coordinator', commit: 'b'.repeat(40) });
  assert.equal(f.board.db.prepare('SELECT COUNT(*) AS n FROM shout').get().n, shoutsBefore, 'landing needs no coordinator status shout');
  const unblockedDelivery = readActivityDelivery(f.board, f.first);
  const unblocked = unblockedDelivery.interrupts.find(entry => entry.reason === 'unblocked' && entry.item === waiting);
  assert.ok(unblocked, 'the released waiting claim retains its immutable notification recipient');
  assert.ok(!readActivityDelivery(f.board, f.second).interrupts.some(entry => entry.reason === 'unblocked' && entry.item === waiting));
  store.recordActivityDelivery(f.board, { agentId: f.first, interrupts: [unblocked], through: unblockedDelivery.cursor });
  store.merged(f.board, dependency, { agentId: 'coordinator', commit: 'b'.repeat(40) });
  assert.equal(kinds(f, waiting, 'work_notice').length, 1, 'a repeated landing does not duplicate the notice');
  assert.deepEqual(itemProgress(f.board, waiting).waits, []);
  assert.equal(itemProgress(f.board, dependency).stage, 'landed');
  f.claim(waiting, f.second);
  assert.equal(store.getItem(f.board, waiting).item_owner, f.second, 'the hold lifts when the wait lands');
});

test('a worktree change and a running board-started check keep a claim active [B4,B5,B13]', async t => {
  const f = fixture(t);
  const a = f.add();
  f.claim(a, f.first);
  // Kept inside the two-hour lease, so only the idle rule, never the lapsed-lease rule, could release it.
  for (let step = 0; step < 2; step += 1) {
    f.advance(30);
    f.touch(f.first, `step-${step}.txt`);
    f.maintain();
  }
  assert.equal(store.getItem(f.board, a).item_status, 'claimed', 'an hour of real file changes keeps building');
  assert.equal(kinds(f, a, 'claim_stalled').length, 0);
  const run = await takeResource({ name: 'gate', scope: 'machine', capacity: 1, root: f.worktrees[f.first], agent: f.first, item: String(a), itemCheck: true, kind: 'check' });
  try {
    f.advance(45);
    f.maintain();
    assert.equal(store.getItem(f.board, a).item_status, 'claimed', 'a long check the board started is not idle');
  } finally { await run.release(); }
  f.maintain();
  assert.equal(store.getItem(f.board, a).item_status, 'open', 'once the check ends, the idle claim is released');
});

test('a large or unreadable claim still releases at 40 minutes, naming what it kept [B4,B5,B13]', t => {
  const f = fixture(t);
  const a = f.add(), b = f.add();
  f.claim(a, f.first);
  // More changed files than a handoff lists: the release still happens and counts the rest.
  for (let file = 0; file < 205; file += 1) f.touch(f.first, `many-${file}.txt`);
  f.advance(41);
  f.maintain();
  assert.equal(store.getItem(f.board, a).item_status, 'open', 'a large change never keeps a claim stalled');
  const large = JSON.parse(kinds(f, a, 'release').at(-1).event_detail);
  const kept = large.idleClaim.handoff;
  assert.equal(kept.changedCount, 205);
  assert.equal(kept.changedFiles.length, 200);
  assert.match(large.reason, /205 file\(s\): .*, \+197 more/u, 'the note counts what it does not list');
  // A worktree that is gone still releases, saying nothing could be pinned.
  f.claim(b, f.second);
  f.touch(f.second, 'gone.txt');
  rmSync(f.worktrees[f.second], { recursive: true, force: true });
  f.advance(41);
  f.maintain();
  assert.equal(store.getItem(f.board, b).item_status, 'open', 'a seat whose worktree is gone is released too');
  assert.match(JSON.parse(kinds(f, b, 'release').at(-1).event_detail).reason, /no work could be pinned/u, 'and says nothing could be pinned');
});

test('an exiting seat releases its claim at once and the next builder sees its handoff [B4,B5,B13,I6]', async t => {
  const dispatched = [];
  await work('SessionEnd', { heartbeat: () => {}, dispatch: async args => { dispatched.push(args); return 0; }, inspect: async () => {} });
  assert.deepEqual(dispatched, [['release', '--session-end']], 'the SessionEnd hook releases the session claims');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ok = result => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  ok((await fixtureAdd(box.runLocal, box.repo, 'web', 'Build the page', '--criterion', 'the page is built', '--json')));
  ok((await box.runLocal(box.web, 'claim', '1', '--json')));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'half built\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): start the page [G1]');
  assert.deepEqual(ok((await box.runLocal(box.web, 'release', '--session-end', '--json'))).released, [1], 'released at once, with no idle wait');
  const released = ok((await box.runLocal(box.repo, 'show', '1', '--json')));
  assert.equal(released.item_status, 'open');
  const next = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', next, 'main');
  ok(joinFixtureSeat(box, next, 'web', { model: FIXTURE_MODEL }));
  const taken = await box.runLocal(next, 'claim', '1');
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.match(taken.out, /handoff from web-1: session ended; work kept at refs\/pullboard\/handoffs\/1\//u, 'the next builder sees why it stopped and where the work is');
});

test('an idle claim after 32 active claims is still released [B4,B5,B13]', t => {
  const f = fixture(t);
  const seats = [f.first, f.second];
  for (let index = 0; index < 31; index += 1) seats.push(f.seat(`extra-${index}`, '4'));
  const ids = seats.map(seat => { const id = f.add(); f.claim(id, seat); return id; });
  f.advance(30);
  for (let index = 0; index < 32; index += 1) f.touch(seats[index], `active-${index}.txt`);
  f.advance(11);
  f.maintain();
  assert.equal(store.getItem(f.board, ids[32]).item_status, 'open', 'the 33rd claim cannot remain stalled past 40 minutes');
  assert.ok(ids.slice(0, 32).every(id => store.getItem(f.board, id).item_status === 'claimed'), 'the active claims stay claimed');
});

test('every pass reads every live claim, so writes in any minute release an idle claim among 65 [B4,B5,B13]', t => {
  const f = fixture(t);
  const seats = [f.first, f.second];
  for (let index = 0; index < 63; index += 1) seats.push(f.seat(`periodic-${index}`, '6'));
  const ids = seats.map(seat => { const id = f.add(); f.claim(id, seat); return id; });
  f.advance(30);
  // The reviewer's shape: the idle claim sits in whichever half a minute-based window would skip.
  const skipped = Math.floor((f.now() + 11 * 60_000) / 60_000) % 2 === 0 ? 64 : 0;
  for (let index = 0; index < seats.length; index += 1) if (index !== skipped) f.touch(seats[index], `active-${index}.txt`);
  f.advance(11);
  f.maintain();
  assert.equal(store.getItem(f.board, ids[skipped]).item_status, 'open', 'one pass releases the idle claim');
  assert.ok(ids.filter((id, index) => index !== skipped).every(id => store.getItem(f.board, id).item_status === 'claimed'), 'the active claims stay claimed');
});


test('active claims return with notes after two hours or three refused submits; a timely submit is untouched [B4,B5,R1]', t => {
  const f = fixture(t);
  const overdue = f.add(), failures = f.add(), timely = f.add();
  f.claim(overdue, f.first);
  store.appendFact(f.board, overdue, { agentId: f.first, kind: 'note', text: 'Work remaining: finish the edge case.', factId: 'builder-note' });
  f.advance(119);
  f.touch(f.first, 'overdue.txt');
  f.claim(overdue, f.first);
  f.maintain();
  assert.equal(store.getItem(f.board, overdue).item_status, 'claimed');
  f.claim(timely, f.second);
  submitFixture(f.board, timely, { agentId: f.second, commit: f.base, tree: f.base });
  f.advance(1);
  f.touch(f.first, 'overdue.txt');
  f.maintain();
  assert.equal(store.getItem(f.board, overdue).item_status, 'open');
  assert.match(JSON.parse(kinds(f, overdue, 'fact').at(-1).event_detail).text, /two hours.*builder-note/u);
  assert.match(JSON.parse(kinds(f, overdue, 'release').at(-1).event_detail).idleClaim.handoff.pin, /handoffs/u);
  assert.equal(store.getItem(f.board, timely).item_status, 'submitted');
  assert.notEqual(store.nextFor(f.board, { agentId: f.first, lane: 'core' }).item?.item_id, overdue);
  f.claim(overdue, f.second);
  assert.equal(store.getItem(f.board, overdue).item_owner, f.second);

  f.claim(failures, f.first);
  for (let n = 0; n < 2; n++) f.claim(failures, f.first, { code: 'CHECK_RED', text: 'fixture red', digest: 'bar' });
  f.maintain();
  assert.equal(store.getItem(f.board, failures).item_status, 'claimed');
  f.claim(failures, f.first, { code: 'CHECK_RED', text: 'fixture red', digest: 'bar' });
  f.maintain();
  assert.equal(store.getItem(f.board, failures).item_status, 'open');
  assert.match(JSON.parse(kinds(f, failures, 'fact').at(-1).event_detail).text, /three failed submits/u);
  const stats = proofStats(f.board, {}, { events: store.events, counterProofStats });
  assert.deepEqual(stats.notesPerSubmit.find(row => row.seat === f.first), { seat: f.first, notes: 1, submits: 0, notesPerSubmit: null });
  assert.deepEqual(stats.notesPerSubmit.find(row => row.seat === f.second), { seat: f.second, notes: 0, submits: 1, notesPerSubmit: 0 });
});


test('three rejected submits return the claim to another seat, including after a lease lapses [B4,B5]', t => {
  const f = fixture(t);
  const id = f.add();
  for (let n = 0; n < 3; n++) {
    f.claim(id, f.first);
    f.git(f.worktrees[f.first], 'commit', '--allow-empty', '-qm', `attempt ${n}`);
    const head = f.git(f.worktrees[f.first], 'rev-parse', 'HEAD');
    submitFixture(f.board, id, { agentId: f.first, commit: head, tree: head });
    store.verify(f.board, id, { agentId: f.second, head, digest: 'bar', policy: 'any', decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'Real proof', note: 'Needs the edge case.' });
    if (n === 1) store.releaseItemHold(f.board, id, { agentId: 'coordinator' });
  }
  // A red gate return holds a re-claimed item for 40 minutes from the reject; the builder takes it back after that.
  f.advance(41);
  f.claim(id, f.first);
  f.advance(31);
  f.maintain();
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.match(JSON.parse(kinds(f, id, 'fact').at(-1).event_detail).text, /three failed submits/u);
  assert.throws(() => f.claim(id, f.second), { code: 'REOPEN_HELD_FOR_BUILDER' }, 'the reviewer who rejected it never takes the first refusal');
  f.claim(id, f.seat('third', '4'));
  // A claim with no renewal must not disappear between the live and long-lapsed scans.
  f.advance(120);
  f.maintain();
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.match(JSON.parse(kinds(f, id, 'fact').at(-1).event_detail).text, /two hours/u);
});


test('board views replace status-only shouts while evidence and questions remain messages [B35]', t => {
  const f = fixture(t);
  const id = f.add();
  f.claim(id, f.first);
  f.advance(5);
  const progress = itemProgress(f.board, id);
  assert.equal(progress.stage, 'claimed');
  assert.equal(progress.holder, f.first);
  assert.equal(progress.idleMinutes, 5);
  for (const text of [`#${id} is stalled`, `#${id} waits on #123`, `please resume #${id}`]) {
    assert.throws(() => store.shout(f.board, { from: 'coordinator', to: f.first, text, lanes: ['core'] }),
      error => error.code === 'BOARD_SHOWS_THIS' && error.message.includes('the board shows this'));
  }
  assert.doesNotThrow(() => store.shout(f.board, { from: 'coordinator', to: f.first,
    text: `#${id} is rejected because the parser loses an empty input; preserve that fixture`, lanes: ['core'] }));
  assert.doesNotThrow(() => store.shout(f.board, { from: 'coordinator', to: f.first,
    text: `#${id} is stalled; which invariant needs a ruling?`, lanes: ['core'] }));
});

/** Count the fast-stage refusals of one holder as recorded submit outcomes. */
function refuse(f, id, agent, code) { f.claim(id, agent, { code, text: `fixture ${code}`, digest: 'bar' }); }

test('a returned claim counts only runner-stage failures: three fast-stage refusals never return it, three gate-reds do [B4,B5]', t => {
  const f = fixture(t);
  const fast = f.add(), runner = f.add();
  f.claim(fast, f.first);
  for (const code of ['MERGE_CONFLICT', 'LINT_RED', 'CUTS_RED', 'STATIC_PROBLEMS']) refuse(f, fast, f.first, code);
  f.advance(31);
  f.maintain();
  assert.equal(store.getItem(f.board, fast).item_status, 'claimed', 'conflict, lint, cuts and static refusals are fixed in minutes and never count');
  f.claim(runner, f.second);
  for (let n = 0; n < 3; n++) refuse(f, runner, f.second, ['GATE_RED', 'CHECK_RED', 'TEST_FAILURE'][n]);
  f.advance(31);
  f.maintain();
  assert.equal(store.getItem(f.board, runner).item_status, 'open', 'three runner-stage failures return the claim');
});

test('a holder who committed in the last 30 minutes is never returned by the progress rule [B4,B5]', t => {
  const f = fixture(t);
  const id = f.add();
  f.claim(id, f.first);
  for (let n = 0; n < 3; n++) refuse(f, id, f.first, 'GATE_RED');
  f.git(f.worktrees[f.first], 'commit', '--allow-empty', '-qm', 'fix: fresh work');
  f.advance(1);
  f.git(f.worktrees[f.first], 'commit', '--allow-empty', '-qm', 'fix: more work');
  f.maintain();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'three red gates with a commit inside 30 minutes stay with the builder');
  f.advance(31);
  f.maintain();
  assert.equal(store.getItem(f.board, id).item_status, 'open', 'with no commit for 30 minutes the same failures return it');
});

test('a returned claim is offered to another builder, never to its reviewer, and its builder may take it back by id [B4,B5]', t => {
  const f = fixture(t);
  const id = f.add();
  f.claim(id, f.first);
  const head = f.git(f.worktrees[f.first], 'rev-parse', 'HEAD');
  submitFixture(f.board, id, { agentId: f.first, commit: head, tree: head });
  store.verify(f.board, id, { agentId: f.second, head, digest: 'bar', policy: 'any', decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'Real proof', note: 'Needs work.' });
  // The reject above is a red return, which holds a re-claimed item for 40 minutes; the builder takes it back after that.
  f.advance(41);
  f.claim(id, f.first);
  for (let n = 0; n < 3; n++) refuse(f, id, f.first, 'GATE_RED');
  f.advance(31);
  f.maintain();
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.throws(() => f.claim(id, f.second), { code: 'REOPEN_HELD_FOR_BUILDER' }, 'the reviewer is refused');
  assert.notEqual(store.nextFor(f.board, { agentId: f.second, lane: 'core' }).item?.item_id, id, 'next never offers it to the reviewer');
  assert.notEqual(store.nextFor(f.board, { agentId: f.first, lane: 'core' }).item?.item_id, id, 'next asks another seat before the original builder');
  assert.equal(store.nextFor(f.board, { agentId: f.helper, lane: 'core' }).item?.item_id, id, 'a different builder is offered it first');
  f.claim(id, f.first);
  assert.equal(store.getItem(f.board, id).item_owner, f.first, 'the original builder re-claims at once when no other seat took it');
});

/** Claim an item, then let its two-hour lease lapse by 41 minutes while the holder's seat keeps heartbeating. Status reads use the stored row: getItem shows a lapsed lease as open. */
function lapsedWhileHeartbeating(f) {
  const id = f.add();
  f.claim(id, f.first);
  f.advance(161);
  assert.equal(heartbeatSeat(f.board, f.first), true, 'the holder has a presence heartbeat');
  return id;
}

/** Commit in the holder's worktree, stamping HEAD's reflog at the board clock as a real commit would be. */
function commitAtBoardTime(f, agent) {
  const root = f.worktrees[agent];
  f.git(root, 'commit', '--allow-empty', '-qm', 'fix: fresh work');
  const log = resolve(root, f.git(root, 'rev-parse', '--git-path', 'logs/HEAD'));
  utimesSync(log, new Date(f.now()), new Date(f.now()));
}

test('clause 1: a claim 41 minutes past its lease with no move, commit or proof run for 40 minutes returns although its seat heartbeats [B4,B5,C7]', t => {
  const f = fixture(t);
  const id = lapsedWhileHeartbeating(f);
  const snapshot = f.maintain();
  const row = snapshot.claims.find(entry => entry.id === id);
  assert.equal(row?.idle, 'release', 'presence is not progress: the idle release takes the lapsed claim');
  assert.ok(row.idleMs >= 40 * 60_000, 'no non-renewal move, commit or proof run for 40 minutes');
  assert.equal(itemById(f.board, id).item_status, 'open');
  assert.equal(JSON.parse(kinds(f, id, 'release').at(-1).event_detail).idleClaim.kind, 'release');
});

test('clause 2: a lapsed claim whose holder moved on it, committed or ran a proof in the last 40 minutes is kept, and returns 40 quiet minutes later [B4,B5,C7]', t => {
  const work = {
    move: (f, id) => store.appendFact(f.board, id, { agentId: f.first, kind: 'note', text: 'Work remaining: one case.', factId: 'lapsed-note' }),
    commit: f => commitAtBoardTime(f, f.first),
    proof: (f, id) => store.logEvent(f.board, f.first, 'proof-run', id, { receipt: { id: 'lapsed-proof', at: new Date(f.now()).toISOString() } }),
  };
  for (const [name, act] of Object.entries(work)) {
    const f = fixture(t);
    const id = lapsedWhileHeartbeating(f);
    act(f, id);
    f.advance(39);
    heartbeatSeat(f.board, f.first);
    const kept = f.maintain();
    assert.equal(kept?.claims.find(entry => entry.id === id), undefined, `${name}: 39 minutes after it nothing returns the claim`);
    assert.equal(itemById(f.board, id).item_status, 'claimed', `${name}: recent work keeps the lapsed claim`);
    f.advance(2);
    heartbeatSeat(f.board, f.first);
    f.maintain();
    assert.equal(itemById(f.board, id).item_status, 'open', `${name}: 41 quiet minutes later the heartbeat alone does not keep it`);
  }
});
