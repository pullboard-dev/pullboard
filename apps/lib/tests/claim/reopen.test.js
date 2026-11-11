import { REJECT_OPEN_ENGINE } from '../../../../packages/state/index.js';
import { REOPEN_FIRST_REFUSAL_ENGINE } from '../../../../packages/state/index.js';
/** @pullboard-test-loads packages/store/src/io/board.js src/claims.js packages/config/src/io/main.js packages/state/src/io/machine.js packages/state/src/io/engine.js */
/** Reopened claims reserve the original builder's context only when enabled [B13,B5]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { submitFixture } from '../../../cli/tests/fixtures/board/submit.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { defaults } from '../../../../packages/config/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { barReadiness } from '../../../../packages/verify/index.js';
import { barReadySetting } from '../../../../packages/verify/index.js';
import { setBarReady } from '../../../../packages/verify/index.js';
import { signBar } from '../../../../packages/verify/index.js';
import { saveAgentSession } from '../../../../packages/seats/index.js';
import { saveAgentParent } from '../../../../packages/seats/index.js';
import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../packages/state/light.js';
import { ITEM_FOLDER_ENGINE } from '../../../../packages/state/light.js';

const COMMIT = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
/** Open a real SQLite board with a clock advanced independently of the host. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-'));
  let at = Date.parse('2026-01-01T00:00:00Z');
  const board = openBoard(join(directory, 'board.sqlite'), { now: () => new Date(at) });
  // These controls prove replay of the former first-refusal policy, not the current rejection rule.
  board.executionEngineVersion = REJECT_OPEN_ENGINE - 1;
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid' });
  const other = store.register(board, { lane: 'core', path: '/other', route: 'mid' });
  return { board, directory, builder, other, advance: (minutes) => { at += minutes * 60_000; } };
}
/** Claim the item with a frozen bar and a bounded lease. */
function claim(f, id, agentId) {
  return store.claim(f.board, id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } } }), digest: 'digest:bar' }) });
}
/** Submit and return an item through the real rejection, landing-failure or conflict path. */
function returned(f, cause, minutes, causeKey) {
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'fix', criterion: 'prove', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves the fix' });
  claim(f, id, f.builder);
  submitFixture(f.board, id, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  const verdict = { agentId: f.other, head: COMMIT, digest: 'digest:bar', policy: 'any', note: 'proof', ...(causeKey ? { cause: causeKey } : {}) };
  if (cause === 'reject') store.verify(f.board, id, { ...verdict, decision: 'REJECT', reason: 'OTHER', clause: 'prove', reopenFirstRefusalMinutes: minutes });
  else {
    store.verify(f.board, id, { ...verdict, decision: 'ACCEPT' });
    store.reopen(f.board, id, { agentId: 'coordinator', reopenFirstRefusalMinutes: minutes, ...(causeKey ? { cause: causeKey } : {}),
      ...(cause === 'conflict' ? { conflict: { files: ['src/a.js'], trunk: TRUNK } }
        : { note: `test/a.test.js: failed case; merge commit ${TRUNK}` }) });
  }
  return id;
}

test('[B13,B5] a reopened item waits for its builder first', (t) => {
  for (const cause of ['reject', 'landing', 'conflict']) {
    const f = fixture(t);
    const id = returned(f, cause, 30);
    const notices = store.inbox(f.board, f.builder).filter(row => row.shout_text.includes('waits for you'));
    assert.equal(notices.length, 1, cause);
    assert.equal(store.recentShouts(f.board).filter(row => row.shout_to === f.builder && row.shout_text.includes('waits for you')).length, 1);
    f.advance(5);
    assert.throws(() => claim(f, id, f.other), error => error.code === 'REOPEN_HELD_FOR_BUILDER'
      && error.message.includes(f.builder) && error.message.includes('2026-01-01T00:30:00.000Z'), cause);
    claim(f, id, f.builder);
    assert.equal(store.getItem(f.board, id).item_owner, f.builder);
    assert.equal(store.inbox(f.board, f.builder).filter(row => row.shout_text.includes('waits for you')).length, 0);
    assert.equal(store.recentShouts(f.board).filter(row => row.shout_to === f.builder && row.shout_text.includes('waits for you')).length, 1);
    f.advance(26);
    // A fresh return keeps the expiry proof independent of a builder's live lease.
    const fresh = fixture(t);
    const expired = returned(fresh, cause, 30);
    fresh.advance(31);
    claim(fresh, expired, fresh.other);
    assert.equal(store.getItem(fresh.board, expired).item_owner, fresh.other);
  }
});


test('[B13,B5] reopen first refusal is a default-off validated board setting', () => {
  assert.equal(defaults().claim.reopenFirstRefusalMinutes, 0);
  assert.equal(configFromSource('{}').claim.reopenFirstRefusalMinutes, 0);
  assert.equal(configFromSource('{"claim":{}}').claim.reopenFirstRefusalMinutes, 0);
  assert.equal(configFromSource('{"claim":{"reopenFirstRefusalMinutes":30}}').claim.reopenFirstRefusalMinutes, 30);
  for (const claim of [null, [], false, { reopenFirstRefusalMinutes: -1 }, { reopenFirstRefusalMinutes: 0.5 },
    { reopenFirstRefusalMinutes: '30' }, { reopenFirstRefusalMinutes: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => configFromSource(JSON.stringify({ claim })), /claim.reopenFirstRefusalMinutes/);
  }
});

test('[B13,B5] first refusal ends on direct builder release, claimed release or exact expiry', (t) => {
  for (const cause of ['reject', 'landing', 'conflict']) {
    for (const mode of ['direct', 'claimed', 'expiry']) {
      const f = fixture(t);
      const id = returned(f, cause, 30);
      assert.throws(() => store.release(f.board, id, f.other, 'This claim belongs to the builder.', 'OTHER'), error => error.code === 'NOT_YOURS');
      f.advance(5);
      if (mode === 'expiry') f.advance(25);
      else {
        if (mode === 'claimed') claim(f, id, f.builder);
        store.release(f.board, id, f.builder, 'Return the claim before reopening the first refusal.', 'OTHER');
      }
      claim(f, id, f.other);
      assert.equal(store.getItem(f.board, id).item_owner, f.other, `${cause}/${mode}`);
    }
  }
});

test('[B13,B5] omitted or zero first refusal keeps reopened claims unchanged', (t) => {
  for (const cause of ['reject', 'landing', 'conflict']) {
    for (const minutes of [undefined, 0]) {
      const f = fixture(t);
      const id = returned(f, cause, minutes);
      assert.equal(store.inbox(f.board, f.builder).filter(row => row.shout_text.includes('waits for you')).length, 0);
      f.advance(5);
      claim(f, id, f.other);
      assert.equal(store.getItem(f.board, id).item_owner, f.other);
    }
  }
});

test('[B13,B5] first refusal does not bypass the existing one-live-claim rule', (t) => {
  const f = fixture(t);
  const id = returned(f, 'landing', 30);
  const second = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'another', route: 'mid',
    criterion: 'prove', check: 'true', brief: 'Files: src/a.js\nTest: proves another fix' });
  claim(f, second, f.builder);
  assert.throws(() => claim(f, id, f.builder), error => error.code === 'ONE_CLAIM');
  store.release(f.board, second, f.builder, 'Return the second fixture claim.', 'OTHER');
  claim(f, id, f.builder);
});


test('[B13,B5] releasing another review cannot cancel the builder reservation', (t) => {
  const f = fixture(t);
  const id = returned(f, 'reject', 30);
  const another = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'review another', route: 'mid',
    criterion: 'prove', check: 'true', brief: 'Files: src/unrelated.js\nTest: proves another fix' });
  claim(f, another, f.other);
  submitFixture(f.board, another, { agentId: f.other, commit: COMMIT, tree: COMMIT });
  store.reserveReview(f.board, another, { agentId: f.builder, leaseMs: 1_800_000, policy: 'any' });
  assert.equal(store.release(f.board, another, f.builder, 'another reviewer can take this', 'ROUTED_ELSEWHERE'), true);
  assert.throws(() => claim(f, id, f.other), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core' }).item, null);
  assert.equal(store.nextFor(f.board, { agentId: f.builder, lane: 'core' }).item.item_id, id);
});

test('[B13,B5,H16] a sealed return persists one window and notice across replay and snapshots', async (t) => {
  // A sealed move carries the current engine, which a later feature may raise past this one.
  const { ENGINE_VERSION } = await import('../../../../packages/state/index.js');
  assert.ok(ENGINE_VERSION >= REOPEN_FIRST_REFUSAL_ENGINE);
  const { firstRefusalArgs } = await import('../../../../packages/items/index.js');
  const f = fixture(t);
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'replay', route: 'mid',
    criterion: 'prove', check: 'true', brief: 'Files: src/a.js\nTest: proves replay' });
  claim(f, id, f.builder);
  submitFixture(f.board, id, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  const args = firstRefusalArgs('verify', [id, { agentId: f.other, decision: 'REJECT', reason: 'OTHER',
    note: 'proof', clause: 'prove', head: COMMIT, digest: 'digest:bar', policy: 'any' }], configFromSource('{"claim":{"reopenFirstRefusalMinutes":30}}'));
  const move = prepareEngineMove(f.board, 'verify', args);
  assert.equal(move.engine, ENGINE_VERSION);
  const historical = { ...move, engine: REOPEN_FIRST_REFUSAL_ENGINE, args: [id, { ...move.args[1] }] };
  delete historical.args[1].clause;
  assert.throws(() => applyEngineMove(f.board, { ...historical, engine: REOPEN_FIRST_REFUSAL_ENGINE - 1 },
    { sequence: 1, at: '2026-01-01T00:00:00Z' }), /engine/);
  const receipt = { sequence: 1, at: '2026-01-01T00:00:00Z' };
  const legacy = openBoard(':memory:');
  t.after(() => store.closeBoard(legacy));
  importBoard(legacy, exportBoard(f.board));
  assert.equal(applyEngineMove(legacy, historical, receipt).error, undefined, 'the clause-free historical return keeps its original floor');
  applyEngineMove(f.board, { ...move, engine: REJECT_OPEN_ENGINE - 1 }, receipt);
  applyEngineMove(f.board, { ...move, engine: REJECT_OPEN_ENGINE - 1 }, receipt);
  assert.equal(store.recentShouts(f.board).filter(row => row.shout_text.includes('waits for you')).length, 1);
  const replica = openBoard(join(f.directory, 'replica.sqlite'), { now: () => new Date('2026-01-01T00:05:00Z') });
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  replica.executionEngineVersion = REJECT_OPEN_ENGINE - 1;
  assert.throws(() => store.claim(replica, id, { agentId: f.other, lane: 'core', leaseMs: 7_200_000, freeze: () => null }),
    error => error.code === 'REOPEN_HELD_FOR_BUILDER' && error.message.includes('2026-01-01T00:30:00.000Z'));
  assert.equal(store.recentShouts(replica).filter(row => row.shout_text.includes('waits for you')).length, 1);
  const claimMove = prepareEngineMove(replica, 'claim', [id, { agentId: f.other, lane: 'core', leaseMs: 7_200_000, freeze: () => null }]);
  assert.throws(() => applyEngineMove(replica, { ...claimMove, engine: REOPEN_FIRST_REFUSAL_ENGINE - 1 }, { sequence: 2, at: '2026-01-01T00:05:00Z' }), /engine/);
  assert.equal(store.getItem(replica, id).item_owner, null);
  assert.equal(prepareEngineMove(replica, 'release', [id, f.builder]).engine, ENGINE_VERSION);
  store.release(replica, id, f.builder, 'Return the replicated fixture claim.', 'OTHER');
  store.claim(replica, id, { agentId: f.other, lane: 'core', leaseMs: 7_200_000, freeze: () => null });
});


test('[B13,B5,D1] a builder notice preserves the reopen cause that triggers rigor', (t) => {
  const f = fixture(t);
  returned(f, 'landing', 30, 'refusal:CHECK_RED');
  returned(f, 'landing', 30, 'refusal:CHECK_RED');
  const notices = store.recentShouts(f.board);
  assert.equal(notices.filter(row => row.shout_from === 'rigor' && row.shout_to === 'coordinator' && row.shout_text.includes('CHECK_RED')).length, 1);
  assert.equal(store.events(f.board).filter(row => row.event_kind === 'rigor-notice' && JSON.parse(row.event_detail).cause === 'refusal:CHECK_RED').length, 1);
  assert.equal(notices.filter(row => row.shout_to === f.builder && row.shout_text.includes('waits for you')).length, 2);
});

/** Synthetic private fixture identities model real root/child registration, never a live board. */
function readyAuthors(f) {
  saveAgentSession(f.board, 'coordinator', 'a'.repeat(64));
  saveAgentParent(f.board, f.builder, 'a'.repeat(64));
  saveAgentSession(f.board, f.builder, 'b'.repeat(64));
  saveAgentSession(f.board, f.other, 'c'.repeat(64));
  f.actors = { coordinator: { session: 'a'.repeat(64), parent: 'a'.repeat(64) },
    [f.builder]: { session: 'b'.repeat(64), parent: 'a'.repeat(64) }, [f.other]: { session: 'c'.repeat(64), parent: 'c'.repeat(64) } };
}
/** Add an authored bar with its exact recorded baseline, as the ordered add operation receives it. */
function readyItem(f, result = 'red') {
  return store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'ready bar', route: 'mid', barActor: f.actors?.coordinator,
    criterion: 'the named behavior works', check: 'node --test --test-name-pattern "named witness" test/a.test.js',
    checkBaseline: { command: 'node --test --test-name-pattern "named witness" test/a.test.js', main: COMMIT, result, testEvidence: { failed: ['named witness'], passed: [], noTestsMatched: false } },
    brief: 'Files: src/a.js\nTest: named witness asserts the behavior\nNamed test: named witness\nMeasurements: no quantitative acceptance bounds\nReviewer edges: empty input and concurrent edit' });
}
/** Sign the currently read revision, keeping stale requests independently testable. */
function signReady(f, id, agentId = f.other) {
  const { revision } = barReadiness(f.board, store.getItem(f.board, id), {}, f.board.runtimePorts.verification);
  return signBar(f.board, id, { agentId, barActor: f.actors?.[agentId], revision: revision.revision, digest: revision.digest,
    note: 'The builder can meet this bar; two reviewers can use the named witness and listed edges to grade it alike.',
    coverage: { version: 1, sourceMain: COMMIT, policyKey: 'd'.repeat(64), sourceCheck: store.getItem(f.board,id).item_check, timeoutMs: 300000, runner: 'node --test', required: [], files: [] } });
}

test('[B4,V2,V1,H16] a claim waits for a bar signed by another session', (t) => {
  const f = fixture(t);
  readyAuthors(f);
  setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  const id = readyItem(f);
  assert.throws(() => claim(f, id, f.builder), error => error.code === 'BAR_NOT_READY' && error.message.includes('sign-off'));
  assert.throws(() => signReady(f, id, 'coordinator'), error => error.code === 'BAR_SELF_SIGN');
  assert.throws(() => signReady(f, id, f.builder), error => error.code === 'BAR_SELF_SIGN', 'a helper cannot sign its parent bar');
  signReady(f, id);
  claim(f, id, f.builder);
  assert.equal(store.getItem(f.board, id).item_owner, f.builder);
  const before = barReadiness(f.board, store.getItem(f.board, id), {}, f.board.runtimePorts.verification).revision;
  store.editItem(f.board, id, { agentId: 'coordinator', brief: store.getItem(f.board, id).item_brief+'\nAlso try a restarted session.', barActor: f.actors.coordinator });
  assert.throws(() => claim(f, id, f.builder), error => error.code === 'BAR_NOT_READY');
  assert.throws(() => signBar(f.board, id, { agentId: f.other, revision: before.revision, digest: before.digest, note: 'stale' }), error => error.code === 'BAR_SIGN_STALE');
  signReady(f, id);
  claim(f, id, f.builder);
  const replica = openBoard(join(f.directory, 'ready-replica.sqlite'));
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  replica.executionEngineVersion = REJECT_OPEN_ENGINE - 1;
  assert.equal(barReadiness(replica, store.getItem(replica, id), {}, replica.runtimePorts.verification).missing.length, 0);
});

test('[B4,V2,H16] readiness is default off and activation preserves old frozen work', (t) => {
  const f = fixture(t);
  assert.equal(barReadySetting(f.board).enabled, false);
  const old = readyItem(f, 'green');
  claim(f, old, f.builder);
  store.release(f.board, old, f.builder, 'Return the old fixture claim.', 'OTHER');
  const activation = setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  assert.deepEqual(setBarReady(f.board, { agentId: 'coordinator', enabled: true }), activation, 'repeating on cannot grandfather new obligations');
  claim(f, old, f.builder);
  claim(f, old, f.builder);
  submitFixture(f.board, old, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  const fresh = readyItem(f, 'green');
  assert.throws(() => claim(f, fresh, f.builder), error => error.code === 'BAR_NOT_READY' && error.message.includes('red check baseline'));
  setBarReady(f.board, { agentId: 'coordinator', enabled: false });
  claim(f, fresh, f.builder);
  store.release(f.board, fresh, f.builder, 'Return the fresh fixture claim.', 'OTHER');
  setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  claim(f, fresh, f.builder);
  assert.throws(() => setBarReady(f.board, { agentId: f.other, enabled: false }), error => error.code === 'COORDINATOR_ONLY');
});

test('[B4,V2] all missing bar parts are named and content reversal cannot revive a signature', (t) => {
  const f = fixture(t);
  readyAuthors(f);
  setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  const incomplete = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'incomplete' });
  assert.throws(() => claim(f, incomplete, f.builder), error => error.code === 'BAR_NOT_READY'
    && ['Named test', 'red check baseline', 'Measurements', 'Reviewer edges', 'sign-off'].every(part => error.message.includes(part)));
  const id = readyItem(f);
  signReady(f, id);
  const original = store.getItem(f.board, id).item_brief;
  store.editItem(f.board, id, { agentId: 'coordinator', brief: original+'\nChanged edge.', barActor: f.actors.coordinator });
  store.editItem(f.board, id, { agentId: 'coordinator', brief: original, barActor: f.actors.coordinator });
  assert.throws(() => claim(f, id, f.builder), error => error.code === 'BAR_NOT_READY' && error.message.includes('sign-off'));
  signReady(f, id);
  claim(f, id, f.builder);
});

test('[B4,V1] unknown lineage and a changed baseline cannot masquerade as peer approval', (t) => {
  const f = fixture(t);
  setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  const id = readyItem(f);
  assert.throws(() => signReady(f, id), error => error.code === 'BAR_PARENT_UNKNOWN');
  readyAuthors(f);
  // Re-authoring creates new known snapshots; it does not relabel the older unknown receipt.
  const fresh = readyItem(f);
  signReady(f, fresh);
  const command = store.getItem(f.board, fresh).item_check;
  const request = '12345678-1234-1234-1234-123456789abc';
  store.editItem(f.board, fresh, { agentId: 'coordinator', check: command, checkBaseline: { command, main: COMMIT, result: 'pending', request } });
  assert.ok(barReadiness(f.board, store.getItem(f.board, fresh), {}, f.board.runtimePorts.verification).missing.some(part => part.includes('red check baseline')));
  store.completeCheckBaseline(f.board, fresh, { agentId: 'coordinator', expected: { command, main: COMMIT, request }, baseline: { command, main: COMMIT, result: 'red', request, testEvidence: { failed: ['named witness'], passed: [], noTestsMatched: false } } });
  assert.ok(barReadiness(f.board, store.getItem(f.board, fresh), {}, f.board.runtimePorts.verification).missing.some(part => part.includes('sign-off')), 'new baseline observation needs a new sign-off');
});


test('[B4,V1] enabling readiness cannot relabel a retained criterion as the later brief editor', (t) => {
  const f = fixture(t);
  readyAuthors(f);
  const brief = 'Files: src/old.js\nTest: old witness\nNamed test: old witness\nMeasurements: no quantitative bounds\nReviewer edges: empty input';
  const id = store.addItem(f.board, { by: f.other, lane: 'core', title: 'original author', criterion: 'original judgement', brief });
  setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  const check = 'node --test --test-name-pattern "old witness" test/old.test.js';
  store.editItem(f.board, id, { agentId: 'coordinator', brief: brief+'\nAn additional edge.', check, barActor: f.actors.coordinator,
    checkBaseline: { command: check, main: COMMIT, result: 'red', testEvidence: { failed: ['old witness'], passed: [], noTestsMatched: false } } });
  const status = barReadiness(f.board, store.getItem(f.board, id), {}, f.board.runtimePorts.verification);
  assert.equal(status.revision.authors.item_criterion.agent, f.other);
  assert.equal(status.revision.authors.item_brief.agent, 'coordinator');
  assert.throws(() => signReady(f, id, f.other), error => error.code === 'BAR_SELF_SIGN');
});


test('[B4,V1,H16] takeover authorship uses the captured current runtime, preserving historical seat identity', t => {
  const f=fixture(t);readyAuthors(f);
  const old = f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('agent_session:coordinator').meta_value;
  // This private move models the normal CLI's new runtime after takeover, not an identity rewrite.
  const current = { session: 'e'.repeat(64), parent: 'e'.repeat(64) };
  f.actors.coordinator=current;
  const child=store.register(f.board,{lane:'core',path:'/new-coordinator-helper',parentDigest:'e'.repeat(64),sessionDigest:'f'.repeat(64)});
  f.actors[child]={session:'f'.repeat(64),parent:'e'.repeat(64)};
  setBarReady(f.board,{agentId:'coordinator',enabled:true});const id=readyItem(f);
  assert.equal(f.board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('agent_session:coordinator').meta_value,old);
  assert.equal(barReadiness(f.board,store.getItem(f.board,id), {}, f.board.runtimePorts.verification).revision.authors.item_criterion.parent,current.parent);
  assert.throws(()=>signReady(f,id,child),error=>error.code==='BAR_SELF_SIGN');
});

test('multi-claim renewal keeps its modern engine floor on replay [B5,H16]', async t => {
  const f = fixture(t);
  const first = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'first', route: 'mid', criterion: 'first works', check: 'true', brief: 'Files: src/a.js\nTest: first works' });
  const second = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'second', route: 'mid', criterion: 'second works', check: 'true', brief: 'Files: src/b.js\nTest: second works' });
  claim(f, first, f.builder);
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'digest:bar' });
  store.claim(f.board, second, { agentId: f.builder, lane: 'core', leaseMs: 7_200_000, freeze, itemFolder: true });
  const move = prepareEngineMove(f.board, 'claim', [first, { agentId: f.builder, lane: 'core', leaseMs: 7_200_000, freeze }]);
  assert.ok(move.engine >= ITEM_FOLDER_ENGINE);
  assert.throws(() => applyEngineMove(f.board, { ...move, engine: ITEM_FOLDER_ENGINE - 1 }, { sequence: 1, at: '2026-01-01T00:01:00Z' }), /engine/);
  assert.equal(store.getItem(f.board, first).item_owner, f.builder);
  assert.equal(store.getItem(f.board, second).item_owner, f.builder);
});

test('older replay retains the one-claim guard even if an unknown modern flag is present [B5,H16]', async t => {
  const f = fixture(t);
  const add = title => store.addItem(f.board, { by: 'coordinator', lane: 'core', title, route: 'mid', criterion: 'works', check: 'true', brief: 'Files: src/a.js\nTest: works' });
  const first = add('legacy first'), second = add('legacy second');
  claim(f, first, f.builder);
  f.board.executionEngineVersion = ITEM_FOLDER_ENGINE - 1;
  assert.throws(() => store.claim(f.board, second, { agentId: f.builder, lane: 'core', leaseMs: 7_200_000, freeze: () => ({ text: '{}', digest: 'd' }), itemFolder: true }), { code: 'ONE_CLAIM' });
  assert.equal(store.getItem(f.board, first).item_owner, f.builder);
  assert.equal(store.getItem(f.board, second).item_owner, null);
});

test('an old modern claim does not upgrade a later legacy claim [B5,H16]', async t => {
  const f = fixture(t);
  const add = title => store.addItem(f.board, { by: 'coordinator', lane: 'core', title, route: 'mid', criterion: 'works', check: 'true', brief: 'Files: src/a.js\nTest: works' });
  const first = add('first'), second = add('second');
  const freeze = () => ({ text: '{}', digest: 'digest:bar' });
  store.claim(f.board, first, { agentId: f.builder, lane: 'core', leaseMs: 7_200_000, freeze, itemFolder: true });
  store.release(f.board, first, f.builder, 'Exercise a fresh legacy claim.', 'OTHER');
  store.claim(f.board, first, { agentId: f.builder, lane: 'core', leaseMs: 7_200_000, freeze });
  const legacy = prepareEngineMove(f.board, 'claim', [second, { agentId: f.builder, lane: 'core', leaseMs: 7_200_000, freeze }]);
  const replay = applyEngineMove(f.board, { ...legacy, engine: ITEM_FOLDER_ENGINE - 1 }, { sequence: 1, at: '2026-01-01T00:01:00Z' });
  assert.equal(replay.error?.code, 'ONE_CLAIM');
});

test('blocked release records prerequisites and withdrawn blockers free the item [B5,B10,H16]', (t) => {
  const f = fixture(t);
  const add = title => store.addItem(f.board, { by: 'coordinator', lane: 'core', title, criterion: 'prove', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves the fix' });
  const blocker = add('blocker');
  const work = add('work');
  store.editItem(f.board, work, { agentId: 'coordinator', after: [blocker], reason: 'Record the prerequisite' });
  assert.equal(store.getItem(f.board, work).item_after, String(blocker));
  assert.throws(() => store.editItem(f.board, blocker, { agentId: 'coordinator', after: [work], reason: 'Would create a cycle' }), error => error.code === 'DEPENDENCY_CYCLE');
  store.editItem(f.board, work, { agentId: 'coordinator', after: [], reason: 'Clear the prerequisite' });
  claim(f, work, f.builder);
  assert.throws(() => store.release(f.board, work, f.builder, '', { blockedOn: [work] }, 'BLOCKED'), error => error.code === 'DEPENDENCY_CYCLE');
  assert.equal(store.getItem(f.board, work).item_status, 'claimed', 'refused release rolls back');
  const move = prepareEngineMove(f.board, 'release', [work, f.builder, 'waiting', { blockedOn: [blocker] }, 'BLOCKED'], { id: 'blocked-release-fixture', actor: f.builder });
  assert.throws(() => applyEngineMove(f.board, { ...move, engine: BLOCKED_DEPENDENCIES_ENGINE - 1 }, { sequence: 1, at: '2026-01-01T00:00:00Z' }), /engine/u, 'older replicas cannot flatten blocked dependencies');
  assert.equal(applyEngineMove(f.board, move, { sequence: 1, at: '2026-01-01T00:00:00Z' }).error, undefined);
  assert.equal(store.getItem(f.board, work).item_after, String(blocker));
  assert.notEqual(store.nextFor(f.board, { agentId: f.other, lane: 'core' }).item?.item_id, work);
  assert.throws(() => claim(f, work, f.other), error => error.code === 'BLOCKED');
  store.withdraw(f.board, blocker, { agentId: 'coordinator', reason: 'No longer needed' });
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core' }).item.item_id, work);
  claim(f, work, f.other);
  assert.equal(store.getItem(f.board, work).item_owner, f.other);
});

test('blocked release waits through acceptance until its prerequisite lands [B5,B10]', t => {
  const f = fixture(t);
  const add = title => store.addItem(f.board, { by: 'coordinator', lane: 'core', title, criterion: 'prove', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves the fix' });
  const blocker = add('prerequisite');
  const work = add('waiting task');
  claim(f, work, f.builder);
  store.release(f.board, work, f.builder, '', { blockedOn: [blocker] }, 'BLOCKED');
  claim(f, blocker, f.builder);
  submitFixture(f.board, blocker, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  store.verify(f.board, blocker, { agentId: f.other, head: COMMIT, digest: 'digest:bar', policy: 'any', decision: 'ACCEPT', note: 'proof' });
  assert.notEqual(store.nextFor(f.board, { agentId: f.other, lane: 'core' }).item?.item_id, work);
  assert.throws(() => claim(f, work, f.other), error => error.code === 'BLOCKED');
  store.merged(f.board, blocker, { agentId: 'coordinator', commit: TRUNK });
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core' }).item.item_id, work);
  claim(f, work, f.other);
});
