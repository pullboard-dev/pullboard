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
import { test } from 'node:test';
import * as store from '../src/board.js';
import { openBoard } from '../src/native-board.js';
import { saveAgentSession } from '../src/seats.js';
import { submitFixture } from './board-submit-fixture.js';
import { runFixtureGit } from './fixture-child.js';
import { captureLapsedClaims } from '../packages/health/index.js';
import { staleStateSnapshot } from '../packages/health/index.js';
import { takeResource } from '../packages/resources/index.js';
import { work } from '../packages/seats/src/core/agent-hook-work.js';
import { createE2eHelpers } from './e2e-helpers.js';

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
  const claim = (id, agentId) => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000, head: base,
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
  return { board, git, repo, base, worktrees, first, second, helper, add, claim, maintain, touch, health,
    advance: minutes => { at += minutes * 60_000; } };
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
  store.merged(f.board, dependency, { agentId: 'coordinator', commit: 'b'.repeat(40) });
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

test('an exiting seat releases its claim at once and the next builder sees its handoff [B4,B5,B13,I6]', async t => {
  const dispatched = [];
  await work('SessionEnd', { heartbeat: () => {}, dispatch: async args => { dispatched.push(args); return 0; }, inspect: async () => {} });
  assert.deepEqual(dispatched, [['release', '--session-end']], 'the SessionEnd hook releases the session claims');
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const ok = result => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  ok(box.run(box.repo, 'add', 'web', 'Build the page', '--criterion', 'the page is built', '--json'));
  ok(box.run(box.web, 'claim', '1', '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.txt'), 'half built\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): start the page [G1]');
  assert.deepEqual(ok(box.run(box.web, 'release', '--session-end', '--json')).released, [1], 'released at once, with no idle wait');
  const released = ok(box.run(box.repo, 'show', '1', '--json'));
  assert.equal(released.item_status, 'open');
  const next = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', next, 'main');
  ok(box.run(next, 'join', 'web', '--json'));
  const taken = box.run(next, 'claim', '1');
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.match(taken.out, /handoff from web-1: session ended; work kept at refs\/pullboard\/handoffs\/1\//u, 'the next builder sees why it stopped and where the work is');
});
