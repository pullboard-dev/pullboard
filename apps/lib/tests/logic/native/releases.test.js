/** Maintenance releases and routing handoffs never count as builder quality refusals [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { addItem } from '../../../../../packages/store/index.js';
import { claim } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { maintainStaleState } from '../../../../../packages/store/index.js';
import { register } from '../../../../../packages/store/index.js';
import { release } from '../../../../../packages/store/index.js';
import { exitClaim } from '../../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../../packages/store/index.js';
import { recordExitProgress } from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../../../../cli/tests/fixtures/board.js';
import { openBoard } from '../../../index.js';
import { captureLapsedClaims } from '../../../../../packages/health/index.js';
import { saveAgentSession } from '../../../../../packages/seats/index.js';
import { runFixtureGit } from '../../../../cli/tests/fixtures/child.js';
import { RELEASE_QUALITY_HOLD_ENGINE } from '../../../../../packages/state/light.js';

/** Real Git worktrees and a private clock make the board's own idle sweep observable. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-quality-release-')));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const repo = join(dir, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'fixture');
  const base = git(repo, 'rev-parse', 'HEAD');
  let at = Date.now() + 60_000;
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => { closeBoard(board); if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
  register(board, { lane: 'coordinator', path: repo });
  /** Register a real detached worktree as one independent builder. */
  const seat = (name, session) => {
    const path = join(dir, name); git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    const id = register(board, { lane: 'core', path, route: 'strong' }); saveAgentSession(board, id, session.repeat(64)); return id;
  };
  const first = seat('first', '1'), second = seat('second', '2'), helper = seat('helper', '3');
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Work', criterion: 'Real proof', route: 'strong' });
  /** Claim under the real item transition with a frozen criterion. */
  const take = (agentId, options = {}) => claim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000, head: base, ...options,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, rows: [], policy: { version: 1, commit: base, verify: { policy: 'any', family: 'off' } } }), digest: 'bar' }) });
  /** Advance past the stale interval and apply the native captured maintenance move. */
  const sweep = () => {
    at += 41 * 60_000;
    const snapshot = captureLapsedClaims({ clock: { now: () => new Date(at) }, config: {} }, board, helper);
    assert.ok(snapshot, 'the board captured idle claim evidence');
    maintainStaleState(board, { agentId: helper, snapshot, health: {}, claimsOnly: true });
  };
  return { board, id, first, second, take, sweep, base };
}

test('lib.logic-native-releases.an-idle-sweep-followed-by-one: an idle sweep followed by one blocked builder release does not hold work [C7]', t => {
  const f = fixture(t);
  f.take(f.first); f.sweep();
  assert.equal(getItem(f.board, f.id).item_status, 'open', 'the native sweep released the claim');
  f.take(f.second); release(f.board, f.id, f.second, 'needs input', 'BLOCKED');
  assert.equal(getItem(f.board, f.id).item_hold_reason, null);
});

test('lib.logic-native-releases.two-builder-quality-releases-still-hold: two builder quality releases still hold, while routing and nonwork releases do not count [C7]', t => {
  const f = fixture(t);
  for (const [reason, note] of [['ROUTED_ELSEWHERE', 'redirect'], ['OTHER', 'dead handoff a8f5b22'], ['OTHER', 'profiling claim latency only; no work done'], ['OTHER', 'arbitrary free-form reason']]) {
    f.take(f.first); release(f.board, f.id, f.first, note, reason);
    assert.equal(getItem(f.board, f.id).item_hold_reason, null);
  }
  f.take(f.first); release(f.board, f.id, f.first, 'first blocker', 'BLOCKED');
  assert.equal(getItem(f.board, f.id).item_hold_reason, null);
  f.take(f.second); release(f.board, f.id, f.second, 'second blocker', 'BLOCKED');
  assert.match(getItem(f.board, f.id).item_hold_reason, /Released twice/u);
});

test('lib.logic-native-releases.old-engine-replay-keeps-its-original: old-engine replay keeps its original released-twice semantics [H16]', t => {
  const f = fixture(t); f.board.executionEngineVersion = RELEASE_QUALITY_HOLD_ENGINE - 1;
  f.take(f.first); release(f.board, f.id, f.first, 'redirect', 'ROUTED_ELSEWHERE');
  f.take(f.second); release(f.board, f.id, f.second, 'blocked', 'BLOCKED');
  assert.match(getItem(f.board, f.id).item_hold_reason, /Released twice/u);
});


test('lib.logic-native-releases.an-untouched-automatic-claim-release-does: an untouched automatic claim release does not count toward the hold [C7]', t => {
  const f = fixture(t), digest = 'c'.repeat(64);
  f.take(f.first, { autoNext: true, autoNextSnapshot: { head: f.base, digest } });
  release(f.board, f.id, f.first, 'untouched', { worktreeSnapshot: { head: f.base, digest } }, 'BLOCKED');
  f.take(f.second); release(f.board, f.id, f.second, 'one actual blocker', 'BLOCKED');
  assert.equal(getItem(f.board, f.id).item_hold_reason, null);
});

test('lib.logic-native-releases.a-budget-exit-handoff-does-not: a budget exit handoff does not count toward the hold [C7]', t => {
  const board = fixtureBoard(t), policy = { enabled: true, tokens: 100, calls: 3 };
  register(board, { id: 'coordinator', lane: 'coordinator', path: '/exit-fixture/main', session: 'fixture-coordinator', model: 'Fixture coordinator' });
  register(board, { id: 'core-1', lane: 'core', path: '/exit-fixture/one', family: 'openai', session: 'fixture-first', model: 'Fixture model' });
  register(board, { id: 'core-2', lane: 'core', path: '/exit-fixture/two', family: 'openai', session: 'fixture-fresh', model: 'Fixture model' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Exit handoff', criterion: 'Retain the handoff.' });
  claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'bar' }), exitRules: policy, exitClaimKey: randomUUID() });
  recordExitProgress(board, { agentId: 'core-1', item: id, claim: exitClaim(board, id, 'core-1').key, tokens: 100, calls: 1 });
  release(board, id, 'core-1', 'Done: saved work; Failed: none; Next: continue the item', 'BUDGET');
  heartbeatSeat(board, 'core-2');
  claim(board, id, { agentId: 'core-2', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'bar' }) });
  release(board, id, 'core-2', 'one actual blocker', 'BLOCKED');
  assert.equal(getItem(board, id).item_hold_reason, null);
});
