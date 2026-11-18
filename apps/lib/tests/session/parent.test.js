import * as queueStore from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { roadmap } from '../../../../packages/store/index.js';
import { eligibilityProblem as queueEligibility } from '../../../../packages/verify/index.js';
/** Parent discovery reads the invoking runtime record and preserves unknown identity [V1,B3]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  joinParentSession,
  parentSessionDigest,
  runtimeParentSession,
  runtimeSessionIdentity,
} from '../../../../packages/items/index.js';
import * as store from '../../../../packages/store/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { submitFixture } from '../../../cli/tests/fixtures/board/submit.js';
import { workQueue } from '../../../../packages/items/index.js';
import {
  prepareEngineMove,
  applyEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { effectiveAgentParent } from '../../../../packages/seats/index.js';

test('lib.session-parent.parent-discovery-reads-only-matching-own: [V1,B3] parent discovery reads only matching own runtime metadata and agrees with --parent', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-parent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions', '2026', '10', '23');
  mkdirSync(sessions, { recursive: true });
  const own = join(sessions, 'rollout-2026-10-23-own-session.jsonl');
  const environment = { CODEX_HOME: home, CODEX_SESSION_ID: 'own-session' };
  writeFileSync(own, JSON.stringify({ type: 'session_meta', payload: { id: 'own-session', parent_thread_id: 'root-session' } }) + '\n');
  writeFileSync(join(sessions, 'rollout-2026-10-23-other-session.jsonl'), '{foreign unreadable metadata');
  assert.equal(runtimeParentSession(environment), 'root-session');
  assert.equal(joinParentSession(undefined, environment), joinParentSession('root-session', {}));
  writeFileSync(own, JSON.stringify({ type: 'session_meta', payload: { id: 'own-session', source: { subagent: { thread_spawn: { parent_thread_id: 'root-session' } } } } }) + '\n');
  assert.equal(runtimeParentSession(environment), 'root-session', 'the runtime thread_spawn shape declares the same parent');
  writeFileSync(own, JSON.stringify({ type: 'session_meta', payload: { id: 'other-session', parent_thread_id: 'foreign-parent' } }) + '\n');
  assert.equal(runtimeParentSession(environment), null, 'a filename alone cannot authenticate another session record');
  assert.equal(joinParentSession(undefined, {}), null, 'missing runtime metadata remains unknown');
  assert.deepEqual(runtimeSessionIdentity({ CODEX_SESSION_ID: 'unrecorded-own-session', CODEX_HOME: home }),
    { session: 'unrecorded-own-session', parent: null }, 'own runtime identity survives missing metadata');
  assert.deepEqual(runtimeSessionIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-own-session', ...environment }),
    { session: 'claude-own-session', parent: null }, 'the native Claude session takes precedence over inherited Codex identity');
  assert.throws(() => joinParentSession('/private/session.jsonl'), { code: 'BAD_PARENT' });
});

test('lib.session-parent.ordered-parent-registration-survives-replay-and: [V1,B3] ordered parent registration survives replay and board export without local session records', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-parent-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const boards = ['source', 'replica', 'imported'].map(name => openBoard(':memory:'));
  t.after(() => boards.forEach(board => store.closeBoard(board)));
  const [source, replica, imported] = boards;
  const move = prepareEngineMove(source, 'register', [{ lane: 'web', path: '/fixture/child', parentDigest: parentSessionDigest('parent-P'), sessionDigest: parentSessionDigest('child-C') }]);
  assert.doesNotMatch(JSON.stringify(move), /parent-P|child-C/u, 'ordered registration exposes only canonical digests');
  const receipt = applyEngineMove(replica, move, { sequence: 1, at: '2026-10-23T12:00:00.000Z' });
  assert.equal(receipt.error, undefined);
  const registered = store.agentAt(replica, '/fixture/child');
  assert.match(registered.agent_parent_session, /^[a-f0-9]{64}$/u);
  importBoard(imported, exportBoard(replica));
  assert.equal(effectiveAgentParent(imported, registered.agent_id), registered.agent_parent_session);
  const legacy = { ...move, id: 'historical-parent-registration', engine: 80,
    args: [{ lane: 'web', path: '/fixture/legacy', parent: 'parent-P', session: 'legacy-C' }] };
  applyEngineMove(replica, legacy, { sequence: 2, at: '2026-10-23T12:01:00.000Z' });
  assert.equal(store.agentAt(replica, '/fixture/legacy').agent_parent_session, null, 'historical moves never invent parent metadata');
});

test('lib.session-parent.an-unknown-parent-primary-session-and: [V1,B3] an unknown-parent primary session and its child cannot review each other, including queue', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-primary-parent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  runFixtureGit(['add', 'pullboard.json'], { cwd: root });
  runFixtureGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture policy'], { cwd: root });
  const board = openBoard(':memory:');
  board.gitRoot = root;
  t.after(() => store.closeBoard(board));
  const primary = store.register(board, { lane: 'web', path: root, family: 'fixture-builder', session: 'primary-R' });
  const child = store.register(board, { lane: 'web', path: join(root, 'child'), family: 'fixture-builder', parent: 'primary-R', session: 'child-C' });
  const outside = store.register(board, { lane: 'review', path: join(root, 'outside'), family: 'fixture-reviewer', parent: 'outside-Q' });
  assert.equal(store.agentById(board, primary).agent_parent_session, null, 'the primary parent is visibly unknown');
  for (const [author, reviewer] of [[primary, child], [child, primary]]) {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Root and child independence', criterion: 'Independent review', check: 'true' });
    store.claim(board, id, { agentId: author, lane: 'web', leaseMs: 3600000, freeze: () => ({ text: 'criterion', digest: 'a'.repeat(64) }) });
    submitFixture(board, id, { agentId: author, commit: String(id).padStart(40, 'a'), tree: String(id).padStart(40, 'b') });
    assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'web', verify: true }).item, null);
    assert.throws(() => store.verify(board, id, { agentId: reviewer, decision: 'ACCEPT', policy: 'any' }), { code: 'SELF_SESSION_VERIFY' });
    assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }, reviewer).unreleased.some(item => item.id === id), false);
    assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }, outside).unreleased.some(item => item.id === id), true);
  }
  assert.throws(() => store.register(board, { lane: 'web', path: join(root, 'child'), parent: 'changed-parent' }), { code: 'PARENT_SESSION_CHANGED' });
});
