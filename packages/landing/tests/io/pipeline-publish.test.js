/** Pipelined publish order: the batch that started first publishes first, observed on a real remote trunk [C7,#8973]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { publish } from '../../src/io/step/publish.js';
import { requirePublishTurn } from '../../src/io/step/publish.js';

const TRUNK = 'refs/heads/main';
const FIRST_AT = '2026-11-16T10:00:00.000Z';
const LATER_AT = '2026-11-16T10:05:00.000Z';

/**
 * A real repository with a bare remote at the base, and two gated batches over it: A (base to tipA) and B (tipA to tipB),
 * each in its own clean worktree. `startedAt` says when each started. The primary checkout stays at the base, as it does
 * until a landing moves main. The publish state is the real publish over them; only the board's record writes, the lease
 * and the finish sequence's side effects (code map, red refresh) are stood in, and the finish still moves main itself.
 */
function pipeline(t, { pipeline: on, startedA, startedB }) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-pipeline-publish-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  runFixtureGit(['clone', '-q', '--bare', repo.root, remote]);
  runFixtureGit(['remote', 'add', 'origin', remote], { cwd: repo.root });
  const base = repo.commit;
  repo.put('a.txt', 'batch A\n');
  const tipA = repo.commitAll();
  repo.put('b.txt', 'batch B\n');
  const tipB = repo.commitAll();
  runFixtureGit(['reset', '-q', '--hard', base], { cwd: repo.root });
  const rootA = join(dir, 'a'), rootB = join(dir, 'b');
  runFixtureGit(['worktree', 'add', '-q', '--detach', rootA, tipA], { cwd: repo.root });
  runFixtureGit(['worktree', 'add', '-q', '--detach', rootB, tipB], { cwd: repo.root });
  const record = (id, root, from, tip, startedAt, other = {}) => ({ version: 1, id, state: 'gating', startedAt, branch: TRUNK, base: from, tip, root, items: [], owner: 'coordinator', revision: 0, ...other });
  const recorded = new Map([['A', record('A', rootA, base, tipA, startedA)], ['B', record('B', rootB, tipA, tipB, startedB)]]);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const landed = [];
  const stateOf = id => ({
    root: repo.root, config: { landing: { pipeline: on } }, board: { db }, batch: recorded.get(id), say: () => {},
    checkLease: async () => {}, checkLeaseNow: () => {},
    landingPorts: { validateQuarantineLandingProof: () => {},
      landingFlakeRatchet: () => ({ allowed: true, unprotected: [], malformed: [], unjustified: [], snapshot: { version: 1, eventId: 0, count: 0, quarantines: [] } }) },
    write: async (name, [args]) => {
      if (name === 'finishLandingBatch') { landed.push(args.id); recorded.set(args.id, { ...recorded.get(args.id), state: 'landed' }); return recorded.get(args.id); }
      recorded.set(args.batch.id, { ...args.batch, revision: args.revision + 1 });
      return recorded.get(args.batch.id);
    },
  });
  const finish = async (_state, { steps }) => { await steps.moveMain(); };
  const run = id => publish(stateOf(id), { batches: () => [...recorded.values()], finish });
  const trunk = () => runFixtureGit(['rev-parse', TRUNK], { cwd: remote });
  return { run, trunk, landed, recorded, stateOf, base, tipA, tipB, main: () => runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo.root }) };
}

test('landing.pipeline-publish.with-landing-pipeline-on-and-two: clause 1: with landing.pipeline on and two batches in flight, the earlier-started batch publishes first [C7]', async t => {
  const p = pipeline(t, { pipeline: true, startedA: FIRST_AT, startedB: LATER_AT });
  const seen = [p.trunk()];
  await p.run('B').then(() => assert.fail('the later batch must not publish first'), error => assert.equal(error.code, 'LAND_MOVED'));
  seen.push(p.trunk());
  await p.run('A');
  seen.push(p.trunk());
  await p.run('B');
  seen.push(p.trunk());
  assert.deepEqual(seen, [p.base, p.base, p.tipA, p.tipB], 'trunk stood at the base while B waited, then took A, then B');
  assert.deepEqual(p.landed, ['A', 'B'], 'the batches landed in start order');
  assert.equal(p.main(), p.tipB, 'the primary checkout followed each publish');
});

test('landing.pipeline-publish.with-landing-pipeline-on-the-later: clause 2: with landing.pipeline on, the later batch never publishes while the earlier one is in flight [C7]', async t => {
  for (const flying of ['merging', 'gating', 'ready', 'pushed']) {
    const p = pipeline(t, { pipeline: true, startedA: FIRST_AT, startedB: LATER_AT });
    p.recorded.set('A', { ...p.recorded.get('A'), state: flying });
    await p.run('B').then(() => assert.fail(`B published while A was ${flying}`), error => {
      assert.equal(error.code, 'LAND_MOVED', flying);
      assert.match(error.message, /A started before B and is still in flight/u, flying);
    });
    assert.equal(p.trunk(), p.base, `the remote trunk did not move while A was ${flying}`);
    assert.deepEqual(p.landed, [], flying);
  }
  const done = pipeline(t, { pipeline: true, startedA: FIRST_AT, startedB: LATER_AT });
  done.recorded.set('A', { ...done.recorded.get('A'), state: 'landed' });
  assert.doesNotThrow(() => requirePublishTurn(done.stateOf('B'), done.recorded.get('B'), { batches: () => [...done.recorded.values()] }), 'once the earlier batch landed, the later one may go');
});

test('landing.pipeline-publish.with-landing-pipeline-off-the-publish: clause 3: with landing.pipeline off the publish path is unchanged from main [C7]', async t => {
  // Here A started after B, so the pipeline on would hold A behind B; the same scene with it off or unset publishes A at once.
  const on = pipeline(t, { pipeline: true, startedA: LATER_AT, startedB: FIRST_AT });
  await on.run('A').then(() => assert.fail('with the pipeline on, A waits for the earlier-started B'), error => assert.equal(error.code, 'LAND_MOVED'));
  assert.equal(on.trunk(), on.base);
  for (const setting of [false, undefined]) {
    const off = pipeline(t, { pipeline: setting, startedA: LATER_AT, startedB: FIRST_AT });
    await off.run('A');
    assert.equal(off.trunk(), off.tipA, `with the pipeline ${setting === false ? 'off' : 'unset'} A publishes at once, as on main`);
    assert.deepEqual(off.landed, ['A']);
  }
});
