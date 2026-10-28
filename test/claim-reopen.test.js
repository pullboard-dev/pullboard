/** @pullboard-test-loads src/board.js src/claims.js src/config.js src/machine.js src/engine.js */
/** Reopened claims reserve the original builder's context only when enabled [B13,B5]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { submitFixture } from './board-submit-fixture.js';
import { configFromSource, defaults } from '../src/config.js';
import { prepareEngineMove, applyEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { barReadiness, barReadySetting, setBarReady, signBar } from '../src/bar-readiness.js';
import { saveAgentSession, saveAgentParent } from '../src/seats.js';

const COMMIT = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
/** Open a real SQLite board with a clock advanced independently of the host. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-'));
  let at = Date.parse('2026-01-01T00:00:00Z');
  const board = store.openBoard(join(directory, 'board.sqlite'), { now: () => new Date(at) });
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
      assert.throws(() => store.release(f.board, id, f.other), error => error.code === 'NOT_YOURS');
      f.advance(5);
      if (mode === 'expiry') f.advance(25);
      else {
        if (mode === 'claimed') claim(f, id, f.builder);
        store.release(f.board, id, f.builder);
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
  store.release(f.board, second, f.builder);
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
  assert.equal(store.release(f.board, another, f.builder, 'another reviewer can take this'), true);
  assert.throws(() => claim(f, id, f.other), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core' }).item, null);
  assert.equal(store.nextFor(f.board, { agentId: f.builder, lane: 'core' }).item.item_id, id);
});

test('[B13,B5,H16] a sealed return persists one window and notice across replay and snapshots', async (t) => {
  const { REOPEN_FIRST_REFUSAL_ENGINE } = await import('../src/machine.js');
  // A sealed move carries the current engine, which a later feature may raise past this one.
  const { ENGINE_VERSION } = await import('../src/machine.js');
  assert.ok(ENGINE_VERSION >= REOPEN_FIRST_REFUSAL_ENGINE);
  const { firstRefusalArgs } = await import('../src/claims.js');
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
  const legacy = store.openBoard(':memory:');
  t.after(() => store.closeBoard(legacy));
  importBoard(legacy, exportBoard(f.board));
  assert.equal(applyEngineMove(legacy, historical, receipt).error, undefined, 'the clause-free historical return keeps its original floor');
  applyEngineMove(f.board, move, receipt);
  applyEngineMove(f.board, move, receipt);
  assert.equal(store.recentShouts(f.board).filter(row => row.shout_text.includes('waits for you')).length, 1);
  const replica = store.openBoard(join(f.directory, 'replica.sqlite'), { now: () => new Date('2026-01-01T00:05:00Z') });
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  assert.throws(() => store.claim(replica, id, { agentId: f.other, lane: 'core', leaseMs: 7_200_000, freeze: () => null }),
    error => error.code === 'REOPEN_HELD_FOR_BUILDER' && error.message.includes('2026-01-01T00:30:00.000Z'));
  assert.equal(store.recentShouts(replica).filter(row => row.shout_text.includes('waits for you')).length, 1);
  const claimMove = prepareEngineMove(replica, 'claim', [id, { agentId: f.other, lane: 'core', leaseMs: 7_200_000, freeze: () => null }]);
  assert.throws(() => applyEngineMove(replica, { ...claimMove, engine: REOPEN_FIRST_REFUSAL_ENGINE - 1 }, { sequence: 2, at: '2026-01-01T00:05:00Z' }), /engine/);
  assert.equal(store.getItem(replica, id).item_owner, null);
  assert.equal(prepareEngineMove(replica, 'release', [id, f.builder]).engine, ENGINE_VERSION);
  store.release(replica, id, f.builder);
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
  const { revision } = barReadiness(f.board, store.getItem(f.board, id));
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
  const before = barReadiness(f.board, store.getItem(f.board, id)).revision;
  store.editItem(f.board, id, { agentId: 'coordinator', brief: store.getItem(f.board, id).item_brief+'\nAlso try a restarted session.', barActor: f.actors.coordinator });
  assert.throws(() => claim(f, id, f.builder), error => error.code === 'BAR_NOT_READY');
  assert.throws(() => signBar(f.board, id, { agentId: f.other, revision: before.revision, digest: before.digest, note: 'stale' }), error => error.code === 'BAR_SIGN_STALE');
  signReady(f, id);
  claim(f, id, f.builder);
  const replica = store.openBoard(join(f.directory, 'ready-replica.sqlite'));
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(f.board));
  assert.equal(barReadiness(replica, store.getItem(replica, id)).missing.length, 0);
});

test('[B4,V2,H16] readiness is default off and activation preserves old frozen work', (t) => {
  const f = fixture(t);
  assert.equal(barReadySetting(f.board).enabled, false);
  const old = readyItem(f, 'green');
  claim(f, old, f.builder);
  store.release(f.board, old, f.builder);
  const activation = setBarReady(f.board, { agentId: 'coordinator', enabled: true });
  assert.deepEqual(setBarReady(f.board, { agentId: 'coordinator', enabled: true }), activation, 'repeating on cannot grandfather new obligations');
  claim(f, old, f.builder);
  claim(f, old, f.builder);
  submitFixture(f.board, old, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  const fresh = readyItem(f, 'green');
  assert.throws(() => claim(f, fresh, f.builder), error => error.code === 'BAR_NOT_READY' && error.message.includes('red check baseline'));
  setBarReady(f.board, { agentId: 'coordinator', enabled: false });
  claim(f, fresh, f.builder);
  store.release(f.board, fresh, f.builder);
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
  assert.ok(barReadiness(f.board, store.getItem(f.board, fresh)).missing.some(part => part.includes('red check baseline')));
  store.completeCheckBaseline(f.board, fresh, { agentId: 'coordinator', expected: { command, main: COMMIT, request }, baseline: { command, main: COMMIT, result: 'red', request, testEvidence: { failed: ['named witness'], passed: [], noTestsMatched: false } } });
  assert.ok(barReadiness(f.board, store.getItem(f.board, fresh)).missing.some(part => part.includes('sign-off')), 'new baseline observation needs a new sign-off');
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
  const status = barReadiness(f.board, store.getItem(f.board, id));
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
  assert.equal(barReadiness(f.board,store.getItem(f.board,id)).revision.authors.item_criterion.parent,current.parent);
  assert.throws(()=>signReady(f,id,child),error=>error.code==='BAR_SELF_SIGN');
});
