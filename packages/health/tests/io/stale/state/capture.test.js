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
import { fixtureBoard } from '../../../../../../apps/cli/tests/fixtures/board.js';
import { policyRepository } from '../../../../../../apps/cli/tests/fixtures/board/submit.js';
import { privateFixtureFiles } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { captureLapsedClaims } from '../../../../index.js';

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

test('clause 1: a quiet seat whose own test run has waited 5 minutes for a runner keeps its claim [B4,#6128,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  f.job({ kind: 'test-run', item: quiet.id, step: 'queued', agent: quiet.holder });
  assert.deepEqual(f.seatGone(), [], 'a run queued 5 minutes ago with no heartbeat is in flight');
});

test('clause 1: a quiet seat whose runner check has run for 5 minutes under a live lease keeps its claim [B4,#6128,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  f.job({ kind: 'test', item: quiet.id, step: 'claimed', owner: 'runner-1', leaseUntil: f.now() + 2 * MINUTE });
  assert.deepEqual(f.seatGone(), [], 'a check whose runner renews its lease is in flight');
});

test('clause 1: a quiet seat whose gate check is running on a runner keeps its claim [B4,#6128,clause 1]', t => {
  const f = fixture(t);
  const [quiet] = f.holders;
  f.job({ kind: 'gate', item: quiet.id, step: 'claimed', owner: 'runner-1', leaseUntil: f.now() + 2 * MINUTE });
  assert.deepEqual(f.seatGone(), [], 'a gate check whose runner renews its lease is in flight');
});

test('clause 2: a quiet seat with no job in flight is still reclaimed at two minutes [B4,#6128,clause 2]', t => {
  const f = fixture(t);
  assert.deepEqual(f.seatGone(), [f.holders[0].id]);
});

test('clause 2: finished, lapsed, long-queued or other-seat jobs do not keep a quiet claim [B4,#6128,clause 2]', t => {
  const f = fixture(t);
  const [quiet, alive] = f.holders;
  f.job({ kind: 'test-run', item: quiet.id, step: 'done', agent: quiet.holder });
  f.job({ kind: 'test', item: quiet.id, step: 'claimed', owner: 'runner-dead', leaseUntil: f.now() - MINUTE });
  f.job({ kind: 'test-run', item: quiet.id, step: 'queued', agent: quiet.holder, createdAgo: 20 * MINUTE });
  f.job({ kind: 'test-run', item: quiet.id, step: 'queued', agent: alive.holder });
  f.job({ kind: 'gate', item: quiet.id, step: 'red' });
  assert.deepEqual(f.seatGone(), [quiet.id]);
});
