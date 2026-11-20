/** A quiet seat waiting on its own test run or check keeps its claim; a quiet seat with nothing in flight is still reclaimed [B4,#6128]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { addItem } from '../../../../../store/index.js';
import { claim } from '../../../../../store/index.js';
import { logEvent } from '../../../../../store/index.js';
import { register } from '../../../../../store/index.js';
import { maintainStaleState } from '../../../../../store/index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { policyRepository } from '../../../../../store/tests/fixtures/submit.js';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../gate/tests/fixtures/child.js';
import { queueTestRun } from '../../../../../drive/index.js';
import { testRunItem } from '../../../../../drive/index.js';
import { captureLapsedClaims } from '../../../../index.js';
import { withdraw } from '../../../../../store/index.js';
import { dependencyWaiters } from '../../../../../items/index.js';
import { dependencyWaitedIds } from '../../../../src/io/stale/state/capture.js';

const MINUTE = 60_000;

/**
 * A real board with two seats claimed twenty minutes ago, each with an idle item folder. The second seat stays alive,
 * so the first going quiet alone is a dead seat, never a machine stall.
 */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-capture-inflight-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  let now = Date.now() - 20 * MINUTE;
  const old = new Date(now);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  register(board, { lane: 'coordinator', path: join(files.root, 'coordinator') });
  const holders = [];
  for (let index = 0; index < 2; index += 1) {
    const root = join(files.root, `seat${index}`);
    mkdirSync(root);
    policyRepository(root);
    writeFileSync(join(root, 'work.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'fixture');
    const holder = register(board, { lane: 'core', path: root, route: 'strong' });
    const id = addItem(board, { by: 'coordinator', lane: 'core', title: `Work ${index}`, criterion: 'Work' });
    claim(board, id, { agentId: holder, lane: 'core', leaseMs: 7_200_000, freeze: () => ({ text: 'Work', digest: 'bar' }) });
    const itemRoot = `${root}-item-${id}`;
    git(root, 'worktree', 'add', '-q', '--detach', itemRoot);
    const log = git(itemRoot, 'rev-parse', '--git-path', 'logs/HEAD').trim();
    for (const path of [join(root, 'work.txt'), join(root, '.git/logs/HEAD'), join(itemRoot, 'work.txt'), join(itemRoot, 'pullboard.json'), log]) utimesSync(path, old, old);
    holders.push({ holder, id });
  }
  const helper = register(board, { lane: 'core', path: join(files.root, 'helper'), route: 'strong' });
  now = Date.now() + 5_000;
  logEvent(board, holders[1].holder, 'fact', holders[1].id, { id: 'alive', kind: 'note', text: 'running the tests', ref: null, supersedes: null });
  const ctx = { clock: { now: () => new Date(now) }, config: {} };
  /** Put one job row on the board as the jobs cell writes it, with its `queued` step when an agent queued it. */
  const job = ({ kind, item, step, owner = null, leaseUntil = 0, createdAgo = 5 * MINUTE, agent = null }) => {
    const id = `${kind}:${item}:${step}:${owner ?? 'none'}:${createdAgo}`;
    const created = now - createdAgo;
    board.db.prepare(`INSERT INTO job (job_id, job_kind, job_item, job_step, job_lease_owner, job_lease_until, job_created, job_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, item, step, owner, leaseUntil, created, created);
    if (agent) board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'queued', ?, ?)")
      .run(id, JSON.stringify({ agent, files: ['a.test.js'] }), created);
  };
  const seatGone = () => (captureLapsedClaims(ctx, board, helper)?.claims ?? []).filter(row => row.idle === 'seat-gone').map(row => row.id);
  return { board, holders, job, seatGone, now: () => now };
}

test('health.capture.waiting-test-run-keeps: clause 1: a quiet seat whose own test run has waited 5 minutes for a runner keeps its claim [B4,#6128,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  f.job({ kind: 'test-run', item: quiet.id, step: 'queued', agent: quiet.holder });
  assert.deepEqual(f.seatGone(), [], 'a run queued 5 minutes ago with no heartbeat is in flight');
});

test('health.capture.runner-check-keeps: clause 1: a quiet seat whose runner check has run for 5 minutes under a live lease keeps its claim [B4,#6128,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  f.job({ kind: 'test', item: quiet.id, step: 'claimed', owner: 'runner-1', leaseUntil: f.now() + 2 * MINUTE });
  assert.deepEqual(f.seatGone(), [], 'a check whose runner renews its lease is in flight');
});

test('health.capture.gate-check-keeps: clause 1: a quiet seat whose gate check is running on a runner keeps its claim [B4,#6128,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  f.job({ kind: 'gate', item: quiet.id, step: 'claimed', owner: 'runner-1', leaseUntil: f.now() + 2 * MINUTE });
  assert.deepEqual(f.seatGone(), [], 'a gate check whose runner renews its lease is in flight');
});

test('health.capture.no-job-reclaimed: clause 2: a quiet seat with no job in flight is still reclaimed at two minutes [B4,#6128,clause 2]', t => {
  const f = fixture(t);
  assert.deepEqual(f.seatGone(), [f.holders[0].id]);
});

test('health.capture.dead-jobs-dont-keep: clause 2: finished, lapsed, long-queued or other-seat jobs do not keep a quiet claim [B4,#6128,clause 2]', t => {
  const f = fixture(t);
  const [quiet, alive] = f.holders;
  f.job({ kind: 'test-run', item: quiet.id, step: 'done', agent: quiet.holder });
  f.job({ kind: 'test', item: quiet.id, step: 'claimed', owner: 'runner-dead', leaseUntil: f.now() - MINUTE });
  f.job({ kind: 'test-run', item: quiet.id, step: 'queued', agent: quiet.holder, createdAgo: 20 * MINUTE });
  f.job({ kind: 'test-run', item: quiet.id, step: 'queued', agent: alive.holder });
  f.job({ kind: 'gate', item: quiet.id, step: 'red' });
  assert.deepEqual(f.seatGone(), [quiet.id]);
});

test('health.capture.item-folder-run-keeps: clause 1: a test run queued from an item folder records that item on its job, so the quiet holder keeps its claim [B4,#6130,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  // A seat may hold several claims (child items are free), so its sole-claim rule names no item; the folder names one.
  const second = quiet.id + 1000;
  const claims = [quiet.id, second];
  assert.equal(testRunItem({ claims }), undefined);
  const item = testRunItem({ folder: quiet.id, claims });
  assert.equal(item, quiet.id);
  assert.equal(testRunItem({ named: second, folder: quiet.id, claims }), second, '--item wins');
  assert.equal(testRunItem({ folder: 999, claims: [quiet.id] }), quiet.id, 'a folder the seat does not hold is ignored');
  const scratch = privateFixtureFiles('pullboard-capture-queue-').root;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const ctx = { info: { root: scratch, commonDir: scratch } };
  const queued = queueTestRun(ctx, work => work(f.board), { agent: quiet.holder, item, items: claims, files: ['a.test.js'], head: null, now: f.now() - 5 * MINUTE },
    { launch: () => ({ unref() {} }), now: f.now() - 5 * MINUTE });
  assert.equal(f.board.db.prepare('SELECT job_item FROM job WHERE job_id = ?').get(queued.id).job_item, quiet.id, 'the job row carries the item');
  assert.deepEqual(f.seatGone(), [], 'the queued run is seen in flight');
});

/**
 * A real board where seat A's claim lapsed an hour past its lease but A still writes events, so every capture keeps it,
 * and seat B holds a live claim. The helper seat captures, as the lapsed pass before a CLI write does.
 */
function lapsedKeptFixture(t) {
  const files = privateFixtureFiles('pullboard-capture-cursor-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  let now = Date.now() - 3 * 60 * MINUTE;
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  register(board, { lane: 'coordinator', path: join(files.root, 'coordinator') });
  const seat = (name, leaseMs) => {
    const root = join(files.root, name);
    mkdirSync(root);
    const holder = register(board, { lane: 'core', path: root, route: 'strong' });
    const id = addItem(board, { by: 'coordinator', lane: 'core', title: `Work ${name}`, criterion: 'Work' });
    claim(board, id, { agentId: holder, lane: 'core', leaseMs, freeze: () => ({ text: 'Work', digest: 'bar' }) });
    return { holder, id };
  };
  const lapsed = seat('lapsed', MINUTE);
  const live = seat('live', 6 * 60 * MINUTE);
  const helper = register(board, { lane: 'core', path: join(files.root, 'helper'), route: 'strong' });
  const alive = ({ holder, id }) => logEvent(board, holder, 'fact', id, { id: `alive-${now}`, kind: 'note', text: 'working', ref: null, supersedes: null });
  const advance = ms => { now += ms; };
  advance(3 * 60 * MINUTE);
  alive(lapsed);
  alive(live);
  const ctx = { clock: { now: () => new Date(now) }, config: {} };
  const capture = () => captureLapsedClaims(ctx, board, helper, { lapsedOnly: true });
  const events = () => board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  return { board, lapsed, live, helper, alive, advance, capture, events, seatRoot: name => join(files.root, name) };
}

test('health.capture.vetoed-lapse-no-write: clause 1: a pass that keeps every lapsed claim and leaves the scan cursor where it is captures nothing, so no maintenance write opens [C7,#10875,clause 1]', t => {
  const f = lapsedKeptFixture(t);
  const first = f.capture();
  assert.ok(first, 'the first pass moves the scan cursor to the lapsed claim, so it is captured');
  assert.deepEqual(first.claims, [], 'the lapsed claim is kept: its seat still writes events');
  maintainStaleState(f.board, { agentId: f.helper, snapshot: first, claimsOnly: true });
  const cursor = () => f.board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='lapsed_claim_scan_cursor'").get()?.meta_value;
  assert.equal(cursor(), String(f.lapsed.id));
  const before = f.events();
  assert.equal(f.capture(), null, 'nothing to decide and the cursor stays put: no snapshot, so the caller opens no write');
  assert.equal(f.capture(), null, 'the next command captures nothing either');
  assert.equal(f.events(), before);
  assert.equal(cursor(), String(f.lapsed.id));
});

test('health.capture.cursor-move-still-captures: clause 2: a pass still captures when the scan cursor would move or a claim row needs a decision [C7,#10875,clause 2]', t => {
  const f = lapsedKeptFixture(t);
  const moved = f.capture();
  assert.equal(moved?.claimScan.previous, 0);
  assert.equal(moved?.claimScan.next, f.lapsed.id, 'the cursor moves, so the pass writes it');
  maintainStaleState(f.board, { agentId: f.helper, snapshot: moved, claimsOnly: true });
  // Seat B goes quiet for three minutes and its worktree is gone while seat A keeps writing: B's claim needs a decision
  // with the cursor unchanged. The write path observes no work, so only a gone worktree makes a live claim decidable.
  rmSync(f.seatRoot('live'), { recursive: true, force: true });
  f.advance(3 * MINUTE);
  f.alive(f.lapsed);
  const decided = f.capture();
  assert.equal(decided?.claimScan.next, decided?.claimScan.previous, 'the cursor stays put');
  assert.deepEqual(decided.claims.map(row => [row.id, row.idle]), [[f.live.id, 'seat-gone']]);
});

test('health.capture.waiters-read-once: clause 1: a lapsed-claim pass over several claims reads the waiting dependents once, not once per claim row [C7,#11998,clause 1]', t => {
  const f = fixture(t);
  const [quiet, alive] = f.holders;
  const dependent = addItem(f.board, { by: 'coordinator', lane: 'core', title: 'Waits on both claims', criterion: 'Work' });
  f.board.db.prepare('UPDATE item SET item_after=? WHERE item_id=?').run(`${quiet.id},${alive.id}`, dependent);
  const db = f.board.db, prepare = db.prepare.bind(db);
  let reads = 0;
  db.prepare = sql => { if (/item_after/u.test(sql)) reads += 1; return prepare(sql); };
  t.after(() => { delete db.prepare; });
  captureLapsedClaims({ clock: { now: () => new Date(f.now()) }, config: {} }, f.board, 'nobody');
  assert.equal(reads, 1, 'one read of the dependents for the whole pass, where main read them once per claim row');
});

test('health.capture.waiters-same-answer: clause 1: the once-per-pass waited set names exactly the ids the per-id dependents query finds [C7,#11998,clause 1]', t => {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/nonexistent/coordinator' });
  const after = (value, status = 'open') => {
    const id = addItem(board, { by: 'coordinator', lane: 'core', title: `After ${value}`, criterion: 'Work' });
    board.db.prepare('UPDATE item SET item_after=? WHERE item_id=?').run(value, id);
    if (status === 'withdrawn') withdraw(board, id, { agentId: 'coordinator', reason: 'fixture' });
    return id;
  };
  after('5');
  after('15,25');
  after('105');
  after('7', 'withdrawn');
  after('');
  const waited = dependencyWaitedIds(board);
  assert.deepEqual([...waited].sort(), ['105', '15', '25', '5']);
  for (let id = 1; id <= 120; id += 1) assert.equal(waited.has(String(id)), dependencyWaiters(board, id).length > 0, `#${id}`);
});

/** A real board: one seat claimed `claimedAgo` minutes ago on a one-minute lease, heartbeating now, and a helper seat to run the capture. */
function idleFixture(t, claimedAgo) {
  const files = privateFixtureFiles('pullboard-capture-idle-30-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  let now = Date.now() - claimedAgo * MINUTE;
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  register(board, { lane: 'coordinator', path: join(files.root, 'coordinator') });
  mkdirSync(join(files.root, 'seat'));
  const holder = register(board, { lane: 'core', path: join(files.root, 'seat'), route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Work', criterion: 'Work' });
  claim(board, id, { agentId: holder, lane: 'core', leaseMs: MINUTE, freeze: () => ({ text: 'Work', digest: 'bar' }) });
  const helper = register(board, { lane: 'core', path: join(files.root, 'helper'), route: 'strong' });
  now = Date.now();
  logEvent(board, holder, 'heartbeat', id, {});
  const rows = () => (captureLapsedClaims({ clock: { now: () => new Date(now) }, config: {} }, board, helper)?.claims ?? []);
  return { id, rows };
}

test('health.io-stale-state-capture.idle-30-releases: clause 2: a claim whose seat heartbeats but made no non-renewal move or commit for 31 minutes is captured as an idle release with a handoff, and none at 29 minutes [C7,#12468,clause 2]', t => {
  const old = idleFixture(t, 31);
  const released = old.rows();
  assert.deepEqual(released.map(row => [row.id, row.idle]), [[old.id, 'release']], 'idle for 31 minutes: released');
  assert.ok(released[0].handoff, 'the release row carries a handoff');
  const young = idleFixture(t, 29);
  assert.deepEqual(young.rows(), [], 'idle for 29 minutes: no row');
});
