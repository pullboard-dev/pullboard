/** The sentinel keeps every claim when most seats miss heartbeats together, and still releases a seat that misses alone [B4,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addItem, claim, logEvent, getItem, register } from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';
import { policyRepository } from './board-submit-fixture.js';
import { captureLapsedClaims, sweepClaims } from '../packages/health/index.js';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { machineStalled } from '../packages/health/src/core/machine-stall.js';

test('clause 1: most claimed seats quiet together is a machine stall, a single quiet seat is not [B4,N2]', () => {
  assert.deepEqual(machineStalled({ claimed: 7, quiet: 5 }), { claimed: 7, quiet: 5 });
  assert.deepEqual(machineStalled({ claimed: 2, quiet: 2 }), { claimed: 2, quiet: 2 });
  assert.equal(machineStalled({ claimed: 1, quiet: 1 }), null, 'one laptop with one builder cannot show a majority');
  assert.equal(machineStalled({ claimed: 7, quiet: 1 }), null, 'a single seat that misses alone is still released');
  assert.equal(machineStalled({ claimed: 6, quiet: 3 }), null, 'half is not most');
});

/** A real board with `count` silent seats, each in its own repository with an item folder idle for twenty minutes. */
function fixture(t, count) {
  const files = privateFixtureFiles('pullboard-machine-stall-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const dir = files.root;
  let now = Date.now() - 20 * 60_000;
  const old = new Date(now);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  register(board, { lane: 'coordinator', path: join(dir, 'coordinator') });
  const holders = [];
  for (let index = 0; index < count; index += 1) {
    const root = join(dir, `seat${index}`);
    mkdirSync(root);
    policyRepository(root);
    writeFileSync(join(root, 'work.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'fixture');
    git(root, 'commit', '-q', '--amend', '--no-edit', '--date', old.toISOString());
    const holder = register(board, { lane: 'core', path: root, route: 'strong' });
    const id = addItem(board, { by: 'coordinator', lane: 'core', title: `Work ${index}`, criterion: 'Work' });
    claim(board, id, { agentId: holder, lane: 'core', leaseMs: 7_200_000, freeze: () => ({ text: 'Work', digest: 'bar' }) });
    const itemRoot = `${root}-item-${id}`;
    git(root, 'worktree', 'add', '-q', '--detach', itemRoot);
    const log = git(itemRoot, 'rev-parse', '--git-path', 'logs/HEAD').trim();
    for (const path of [join(root, 'work.txt'), join(root, '.git/logs/HEAD'), join(itemRoot, 'work.txt'), join(itemRoot, 'pullboard.json'), log]) utimesSync(path, old, old);
    holders.push({ holder, id });
  }
  const helper = register(board, { lane: 'core', path: join(dir, 'helper'), route: 'strong' });
  now = Date.now() + 5_000;
  const ctx = { clock: { now: () => new Date(now) }, config: {} };
  return { board, holders, helper, ctx, capture: () => captureLapsedClaims(ctx, board, helper) };
}

test('clause 1: the real capture releases nothing when every claimed seat goes quiet together, and says so once [B4,N2]', t => {
  const f = fixture(t, 2);
  const snapshot = f.capture();
  assert.equal(snapshot?.claims.some(row => row.idle === 'seat-gone') ?? false, false, 'no seat is reclaimed for the stalled window');
  assert.equal(f.ctx.machineStall.quiet, 2);
  assert.equal(f.ctx.machineStall.claimed, 2);
  for (const { holder, id } of f.holders) assert.equal(getItem(f.board, id).item_owner, holder);
});

test('clause 1: a single seat that misses alone is still released [B4,N2]', t => {
  const f = fixture(t, 2);
  logEvent(f.board, f.holders[1].holder, 'fact', f.holders[1].id, { id: 'alive', kind: 'note', text: 'running the tests', ref: null, supersedes: null });
  const snapshot = f.capture();
  assert.equal(f.ctx.machineStall, undefined, 'one quiet seat of two is not the machine');
  assert.deepEqual(snapshot.claims.filter(row => row.idle === 'seat-gone').map(row => row.id), [f.holders[0].id]);
});

test('clause 1: a sentinel tick that runs late is a machine stall even when one seat alone is quiet [B4,N2]', () => {
  const minute = 60_000;
  assert.equal(machineStalled({ claimed: 7, quiet: 1, gapMs: 10 * minute }), null, 'an on-time tick with one quiet seat is a dead seat');
  assert.equal(machineStalled({ claimed: 7, quiet: 0, gapMs: 40 * minute }), null, 'a late tick with every seat alive holds nothing');
  assert.deepEqual(machineStalled({ claimed: 7, quiet: 1, gapMs: 40 * minute }), { claimed: 7, quiet: 1, lateByMs: 30 * minute });
});

test('clause 1: the real sweep releases a lone silent seat on time and holds it, with one machine-stall shout, when its own tick ran late [B4,N2]', async t => {
  const minute = 60_000;
  /** Run the real sweep as if the previous sweep started `previousMinutesAgo` minutes earlier. */
  const sweep = async previousMinutesAgo => {
    const f = fixture(t, 2);
    logEvent(f.board, f.holders[1].holder, 'fact', f.holders[1].id, { id: 'alive', kind: 'note', text: 'running the tests', ref: null, supersedes: null });
    const previous = new Date(f.ctx.clock.now().getTime() - previousMinutesAgo * minute).toISOString();
    f.board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run('claim_sweep_at', previous);
    const shouts = [];
    const snapshot = await sweepClaims(f.ctx, f.board, f.helper, async () => ({}), {
      recordClaimWorktrees() {}, captureClaimWatchdogSnapshot() { return null; }, runScheduledClaimWatchdog() {}, shout: message => shouts.push(message) });
    return { f, shouts, released: (snapshot?.claims ?? []).filter(row => row.idle === 'seat-gone').map(row => row.id) };
  };
  const onTime = await sweep(10);
  assert.deepEqual(onTime.released, [onTime.f.holders[0].id], 'on time, the lone silent seat is released as before');
  assert.equal(onTime.shouts.length, 0);
  const late = await sweep(40);
  assert.deepEqual(late.released, [], 'with the sentinel tick late, no claim is released for a missed heartbeat');
  assert.equal(late.shouts.length, 1, 'one machine-stall shout');
  assert.match(late.shouts[0].text, /sentinel tick ran 30 minutes late/u);
  for (const { holder, id } of late.f.holders) assert.equal(getItem(late.f.board, id).item_owner, holder);
});
