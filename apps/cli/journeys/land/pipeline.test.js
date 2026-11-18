/** Pipelined landing: batch N+1 lands without a second gate when N lands, and is gated again on main when N fails [C7,#3155,#8938]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { publish } from '../../../../packages/landing/index.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';

const TRUNK = 'refs/heads/main';
const FIRST_AT = '2026-11-16T10:00:00.000Z';
const LATER_AT = '2026-11-16T10:05:00.000Z';

/**
 * A real repository with a bare remote at the base, and two gated batches over it: N (base to tipN) and N+1 (tipN to tipM),
 * each in its own clean worktree. Only the board's record writes, the lease and the finish side effects are stood in;
 * `gates` counts every call that would gate a batch, so a test can show a landing made none.
 */
function pipeline(t) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-pipeline-journey-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  runFixtureGit(['clone', '-q', '--bare', repo.root, remote]);
  runFixtureGit(['remote', 'add', 'origin', remote], { cwd: repo.root });
  const base = repo.commit;
  repo.put('n.txt', 'batch N\n');
  const tipN = repo.commitAll();
  repo.put('m.txt', 'batch N+1\n');
  const tipM = repo.commitAll();
  runFixtureGit(['reset', '-q', '--hard', base], { cwd: repo.root });
  const rootN = join(dir, 'n'), rootM = join(dir, 'm');
  runFixtureGit(['worktree', 'add', '-q', '--detach', rootN, tipN], { cwd: repo.root });
  runFixtureGit(['worktree', 'add', '-q', '--detach', rootM, tipM], { cwd: repo.root });
  const record = (id, root, from, tip, startedAt) => ({ version: 1, id, state: 'ready', startedAt, branch: TRUNK, base: from, tip, root, items: [], owner: 'coordinator', revision: 0 });
  const recorded = new Map([['N', record('N', rootN, base, tipN, FIRST_AT)], ['M', record('M', rootM, tipN, tipM, LATER_AT)]]);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const landed = [];
  const gates = [];
  const stateOf = id => ({
    root: repo.root, config: { landing: { pipeline: true } }, board: { db, clock: { now: () => new Date(LATER_AT) } }, batch: recorded.get(id), say: () => {},
    checkLease: async () => {}, checkLeaseNow: () => {},
    landingPorts: { validateQuarantineLandingProof: () => {},
      landingFlakeRatchet: () => ({ allowed: true, unprotected: [], malformed: [], unjustified: [], snapshot: { version: 1, eventId: 0, count: 0, quarantines: [] } }) },
    gate: () => gates.push(id),
    write: async (name, [args]) => {
      if (name === 'finishLandingBatch') { landed.push(args.id); recorded.set(args.id, { ...recorded.get(args.id), state: 'landed' }); return recorded.get(args.id); }
      recorded.set(args.batch.id, { ...args.batch, revision: args.revision + 1 });
      return recorded.get(args.batch.id);
    },
  });
  const finish = async (_state, { steps }) => { await steps.moveMain(); };
  const run = id => publish(stateOf(id), { batches: () => [...recorded.values()], finish });
  const trunk = () => runFixtureGit(['rev-parse', TRUNK], { cwd: remote });
  return { run, trunk, landed, gates, recorded, base, tipN, tipM };
}

test('cli.journeys-land-pipeline.with-landing-pipeline-on-when-batch: clause 1: with landing.pipeline on, when batch N lands, batch N+1 lands without re-gating [C7,#3155,#8938]', async t => {
  const p = pipeline(t);
  await p.run('N');
  assert.equal(p.trunk(), p.tipN, 'batch N moved trunk');
  const before = p.recorded.get('M');
  await p.run('M');
  assert.equal(p.trunk(), p.tipM, 'batch N+1 moved trunk on top of N');
  assert.deepEqual(p.landed, ['N', 'M']);
  assert.deepEqual(p.gates, [], 'no batch was gated again');
  assert.equal(before.base, p.tipN, 'batch N+1 kept the base it gated on');
});

test('cli.journeys-land-pipeline.with-landing-pipeline-on-when-batch-2: clause 2: with landing.pipeline on, when batch N fails, batch N+1 is discarded and gated again on main [C7,#3155,#8938]', async t => {
  const p = pipeline(t);
  p.recorded.set('N', { ...p.recorded.get('N'), state: 'blocked' });
  await p.run('M').then(() => assert.fail('N+1 must not publish on top of a failed batch'), error => assert.equal(error.code, 'LAND_MAIN_MOVED'));
  assert.equal(p.trunk(), p.base, 'trunk never took the discarded batch');
  assert.deepEqual(p.landed, []);
  const discarded = p.recorded.get('M');
  assert.equal(discarded.state, 'blocked', 'the discarded batch is recorded blocked, so the lander gates it again');
  assert.equal(discarded.refusal.code, 'LAND_MAIN_MOVED');
  assert.match(discarded.refusal.message, /N failed, and M was gated on top of it/u);
});
