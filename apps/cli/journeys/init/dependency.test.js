/** Measured dependency inactivity uses its own interval and keeps native running work [B4,B5,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import {
  itemFolderPath,
  writeItemMarker,
} from '../../index.js';
import * as store from '../../../../packages/store/index.js';
import { saveAgentSession } from '../../../../packages/seats/index.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

/** A real Git/SQLite board, validated item folder and private resource pool on an explicit clock. */
function fixture(t, health = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stranded-dependency-')));
  const priorHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(key)) delete env[key];
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'work.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture: base');
  const base = git(repo, 'rev-parse', 'HEAD');
  let at = Date.now() + 60_000;
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => {
    store.closeBoard(board);
    if (priorHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = priorHome;
    rmSync(dir, { recursive: true, force: true });
  });
  store.register(board, { lane: 'coordinator', path: repo });
  /** A distinct synthetic fixture seat is registered in its own real worktree. */
  function seat(name, digest) {
    const path = join(dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    const id = store.register(board, { lane: 'core', path, route: 'strong' });
    saveAgentSession(board, id, digest.repeat(64));
    return { id, path };
  }
  const builder = seat('builder', '1'), helper = seat('helper', '2');
  /** Create an ordinary core item, with local prerequisite membership stored by the board. */
  const add = (title, after = []) => store.addItem(board, { by: 'coordinator', lane: 'core', title,
    criterion: 'The fixture work is observable [test]', specIds: [], route: 'strong', check: 'true', after });
  const dependency = add('Dependency'), dependent = add('Dependent', [dependency]);
  const claimOptions = { agentId: builder.id, lane: 'core', leaseMs: 8 * 3_600_000, head: base,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, rows: [],
      policy: { version: 1, commit: base, verify: { policy: 'any', family: 'off' } } }), digest: 'fixture-bar' }) };
  store.claim(board, dependency, claimOptions);
  const itemRoot = itemFolderPath(builder.path, dependency);
  git(repo, 'worktree', 'add', '-q', '-b', `core/item-${dependency}`, itemRoot, base);
  writeItemMarker(itemRoot, builder.id, dependency);
  const ctx = { clock: { now: () => new Date(at) }, config: { health } };
  /** The builder remains present; presence is not a commit, test or item fact. */
  const capture = () => {
    store.heartbeatSeat(board, builder.id);
    return captureLapsedClaims(ctx, board, helper.id);
  };
  /** Apply only the actual captured native observation, preserving its board-prefix validation. */
  const apply = snapshot => snapshot && store.maintainStaleState(board, { agentId: helper.id, snapshot, health, claimsOnly: true });
  return { board, repo, git, builder, helper, dependency, dependent, itemRoot, capture, apply, base,
    tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
    now: () => new Date(at).toISOString(),
    advance: minutes => { at += minutes * 60_000; },
    renew: () => store.claim(board, dependency, claimOptions),
    maintain: () => apply(capture()),
    fact: text => store.appendFact(board, dependency, { agentId: builder.id, kind: 'note', text }) };
}

test('clause 1: a dependency waits its full default two hours then releases with its work and original queue rank [B4,B5,C7]', t => {
  const f = fixture(t);
  assert.equal(f.board.enginePorts.claimedItemRoot(f.board, store.getItem(f.board, f.dependency)), f.itemRoot);
  f.advance(119);
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_owner, f.builder.id, 'the generic forty-minute idle rule cannot shorten the dependency interval');
  f.advance(1);
  const snapshot = f.capture();
  assert.equal(snapshot.limits.dependency, 2 * 3_600_000);
  assert.equal(snapshot.claims.find(row => row.id === f.dependency)?.idle, 'dependency');
  f.apply(snapshot);
  assert.equal(store.getItem(f.board, f.dependency).item_status, 'open');
  assert.equal(store.getItem(f.board, f.dependency).item_owner, null);
  const released = store.events(f.board, { itemId: f.dependency }).findLast(event => event.event_kind === 'release');
  const detail = JSON.parse(released.event_detail);
  assert.match(detail.reason, /Stale dependency:.*health\.dependencyIdle/u);
  assert.ok(detail.idleClaim.handoff.pin);
  const offer = store.nextFor(f.board, { agentId: f.helper.id, lane: 'core' });
  assert.equal(offer.item?.item_id, f.dependency, 'the prerequisite is offered again ahead of its still-blocked dependent');
  assert.ok(store.allShouts(f.board).some(shout => shout.shout_text.includes(`Dependency #${f.dependency} of #${f.dependent}`)), 'the waiting dependent receives its native notice');
});

test('configured dependency inactivity restarts at a real fact while claim renewal does not count [B4,B5,C7]', t => {
  const f = fixture(t, { dependencyIdle: '3h' });
  f.advance(120);
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_status, 'claimed');
  f.fact('Measured builder progress');
  f.advance(179);
  f.renew();
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_status, 'claimed');
  f.advance(1);
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_status, 'open');
});

test('a real admitted item check keeps a stale dependency regardless of logical heartbeat age [B4,B5,C7]', async t => {
  const f = fixture(t);
  const lease = await takeResource({ name: 'gate', scope: 'machine', capacity: 1, root: f.itemRoot,
    agent: f.builder.id, item: String(f.dependency), itemCheck: true, kind: 'check' });
  try {
    f.advance(240);
    f.maintain();
    assert.equal(store.getItem(f.board, f.dependency).item_owner, f.builder.id, 'retained native custody is never inferred dead from heartbeat age');
  } finally { await lease.release(); }
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_status, 'open', 'ended custody permits an ordinary fresh observation');
});

test('progress after capture invalidates dependency release through the native event-prefix fence [B4,B5,C7]', t => {
  const f = fixture(t);
  f.advance(120);
  const snapshot = f.capture();
  f.fact('Work appeared after observation');
  assert.throws(() => f.apply(snapshot), error => error.code === 'STALE_STATE_CHANGED');
  assert.equal(store.getItem(f.board, f.dependency).item_owner, f.builder.id);
});

test('a foreign item-folder marker is unknown evidence and cannot release the claimed dependency [B4,B5,C7]', t => {
  const f = fixture(t);
  writeItemMarker(f.itemRoot, f.helper.id, f.dependency);
  f.advance(180);
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_owner, f.builder.id);
});

for (const kind of ['check', 'submit']) {
  test(`a recorded owner-bound ${kind} gate-run resets inactivity at execution time [B4,B5,C7]`, t => {
    const f = fixture(t);
    f.advance(119);
    // Synthetic replay-event data exercises the projection, not a fabricated native test receipt or proof.
    store.logEvent(f.board, f.builder.id, 'gate-run', null, { run: { version: 2, head: f.base, tree: f.tree, kind, at: f.now(),
      proof: { item: f.dependency, seat: f.builder.id } } });
    f.advance(119);
    f.maintain();
    assert.equal(store.getItem(f.board, f.dependency).item_status, 'claimed');
    f.advance(1);
    f.maintain();
    assert.equal(store.getItem(f.board, f.dependency).item_status, 'open');
  });
}

test('foreign comparisons, unbound runs and late records of pre-claim tests do not manufacture progress [B4,B5,C7]', t => {
  const f = fixture(t);
  const beforeClaim = new Date(Date.parse(f.now()) - 1).toISOString();
  f.advance(119);
  // Explicit invalid/irrelevant replay controls never enter the production receipt writer.
  for (const [actor, run] of [
    [f.helper.id, { kind: 'check', at: f.now(), proof: { item: f.dependency, seat: f.helper.id } }],
    [f.builder.id, { kind: 'main-red', at: f.now(), proof: { item: f.dependency, seat: f.builder.id } }],
    [f.builder.id, { kind: 'check', at: f.now(), proof: { seat: f.builder.id } }],
    [f.builder.id, { kind: 'check', at: beforeClaim, proof: { item: f.dependency, seat: f.builder.id } }],
  ]) store.logEvent(f.board, actor, 'gate-run', null, { run: { version: 2, head: f.base, tree: f.tree, ...run } });
  f.advance(1);
  f.maintain();
  assert.equal(store.getItem(f.board, f.dependency).item_status, 'open');
});
