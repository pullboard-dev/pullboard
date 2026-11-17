/** An item whose pulled gate job is open keeps its claim when its builder seat stops, and the gate result still records on it [C7,#8650]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureBoard } from '../../fixtures/board.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { policyRepository } from '../../fixtures/board/submit.js';
import { addItem } from '../../../../../packages/store/index.js';
import { claim } from '../../../../../packages/store/index.js';
import { logEvent } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { postReceipt } from '../../../../../packages/api/index.js';
import { applyGateReceipt } from '../../../../../packages/api/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { reclaimPass } from '../../../../../packages/drive/index.js';
import { captureLapsedClaims } from '../../../../../packages/health/index.js';
import { servingNow } from '../../../src/io/reclaim.js';

const MINUTE = 60_000;
const SOURCE = 'c'.repeat(40);
const MAIN = 'd'.repeat(40);

/**
 * A real board with two seats that claimed an item twenty minutes ago, each with an idle item folder. The first seat
 * submitted and stopped: its pulled gate job was offered 18 minutes ago (past the 15-minute queue window) and its runner's
 * lease lapsed. The second seat stays alive, so the first going quiet alone is a stopped seat, never a machine stall.
 */
function fixture(t, { gate = true } = {}) {
  const files = privateFixtureFiles('pullboard-offered-claim-');
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
  const [stopped, alive] = holders;
  const job = `gate:${stopped.id}:${SOURCE.slice(0, 12)}:fixture`;
  if (gate) {
    offerJob(board.db, { id: job, kind: 'gate', priority: 'gate', item: stopped.id, candidate: SOURCE, base: MAIN, now: now + 2 * MINUTE,
      request: { submit: { agentId: stopped.holder, digest: 'bar' } } });
  }
  const helper = register(board, { lane: 'core', path: join(files.root, 'helper'), route: 'strong' });
  now = Date.now() + 5_000;
  logEvent(board, alive.holder, 'fact', alive.id, { id: 'alive', kind: 'note', text: 'running the tests', ref: null, supersedes: null });
  const ctx = { clock: { now: () => new Date(now) }, config: {} };
  const seatGone = () => (captureLapsedClaims(ctx, board, helper)?.claims ?? []).filter(row => row.idle === 'seat-gone').map(row => row.id);
  return { board, stopped, job, seatGone, now: () => now };
}

test('cli.io-gate-offered-claim.a-quiet-seat-with-no-gate-job: clause 1: a quiet seat with no gate job is reclaimed at two minutes, so the fixture reads a stopped seat [C7,#8650]', t => {
  const f = fixture(t, { gate: false });
  assert.deepEqual(f.seatGone(), [f.stopped.id]);
});

test('cli.io-gate-offered-claim.an-item-with-an-offered-gate-job: clause 1: an item with an offered gate job is not released for a missing heartbeat while the job is open [C7,#8650]', async t => {
  const f = fixture(t);
  assert.deepEqual(f.seatGone(), [], 'an offered gate job, past the queue window with no runner yet, keeps the claim');
  // A runner takes the job and dies: its lease lapses, and a command's fallback reclaim pass reads the job as lapsed.
  const held = claimJob(f.board.db, { runner: 'runner-dead', now: f.now() - 10 * MINUTE, leaseMs: 2 * MINUTE });
  assert.equal(held?.job, f.job);
  const pass = await reclaimPass(f.board.db, { owner: 'fallback:status:1', now: f.now, active: view => servingNow(f.board, view), drive: async () => ({ transition: null }) });
  assert.equal(pass.lapsed, 1, 'the lapsed gate job is left for a driver, never ended');
  const view = jobView(f.board.db, f.job);
  assert.notEqual(view.step, 'done', 'the open gate job is not withdrawn as stale while its item is claimed');
  assert.ok(!view.steps.some(step => step.name === 'withdrawn'), 'no stale withdrawal step');
  assert.deepEqual(f.seatGone(), [], 'the claim is still kept while its gate job is open');
  assert.deepEqual([getItem(f.board, f.stopped.id).item_status, getItem(f.board, f.stopped.id).item_owner], ['claimed', f.stopped.holder]);
});

test('cli.io-gate-offered-claim.a-claimed-item-s-older-gate-job: clause 1: a claimed item\'s older gate job is still ended stale once a newer one is offered [C7,#8650]', t => {
  const f = fixture(t);
  offerJob(f.board.db, { id: `${f.job}:newer`, kind: 'gate', priority: 'gate', item: f.stopped.id, candidate: 'e'.repeat(40), base: MAIN, now: f.now() - MINUTE,
    request: { submit: { agentId: f.stopped.holder, digest: 'bar' } } });
  assert.equal(servingNow(f.board, jobView(f.board.db, f.job)), false);
  assert.equal(servingNow(f.board, jobView(f.board.db, `${f.job}:newer`)), true);
});

test('cli.io-gate-offered-claim.the-gate-result-still-records-on-the: clause 2: the gate result still records on the item after its builder seat stops [C7,#8650]', async t => {
  const f = fixture(t);
  const held = claimJob(f.board.db, { runner: 'runner-1', now: f.now() - 10 * MINUTE, leaseMs: 2 * MINUTE });
  await reclaimPass(f.board.db, { owner: 'fallback:next:1', now: f.now, active: view => servingNow(f.board, view), drive: async () => ({ transition: null }) });
  assert.deepEqual(f.seatGone(), [], 'the stopped seat still holds the claim when the runner posts');
  const receipt = { status: 1, gate: { green: false, error: 'proof not ok: a.test.js', phases: [] } };
  postReceipt(f.board.db, { job: held.job, runner: 'runner-1', token: held.token, receipt, now: f.now() });
  const applied = applyGateReceipt(f.board, { job: held.job, receipt });
  assert.deepEqual([applied.applied, applied.outcome], [true, 'red'], `the receipt applies to the item: ${JSON.stringify(applied)}`);
  const facts = f.board.db.prepare("SELECT json_extract(event_detail, '$.text') AS text FROM event WHERE item_id = ? AND event_kind = 'fact'").all(f.stopped.id).map(row => row.text);
  assert.ok(facts.some(text => text.startsWith(`Gate job ${f.job} red at ${SOURCE.slice(0, 12)}`)), `the red result is on the item's thread: ${facts.join(' | ')}`);
});
