/** Seat identity survives heartbeat-based presence changes on a real SQLite board [B3]. */
import assert from 'node:assert/strict';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  fixtureBoard,
} from '../../../tests/fixtures/board.js';
import {
  readFileSync,
} from 'node:fs';
import {
  gunzipSync,
} from 'node:zlib';
import {
  decodeBoardKey,
  unseal,
} from '../../../../../packages/kernel/index.js';
import {
  ENGINE_VERSION,
} from '../../../../../packages/state/index.js';
import {
  legacyRelayClientFixture,
} from '../../../tests/fixtures/relay/client.js';
import {
  relayWorkBudgetMs,
} from '../../../tests/fixtures/relay/budget.js';

test('a write after a heartbeat uploads once [B3,H16]', {
  timeout: relayWorkBudgetMs(), // budget: unchanged six-attempt relay fixture allowance, not a speed target.
}, async t => {
  const box = await legacyRelayClientFixture(t);
  await box.link();
  const boardFile = join(box.root, '.git', 'pullboard', 'board.sqlite');
  const presenceFile = boardFile + '.presence.sqlite';
  const freshText = 'PUBLISHER_HEARTBEAT_FRESH';
  const staleText = 'PUBLISHER_HEARTBEAT_STALE';
  const fresh = await box.cliWithSnapshotTrace(1, 'shout', box.lane, freshText);
  t.diagnostic('fresh write: ' + JSON.stringify(traceEvidence(fresh)));
  assert.equal(fresh.code, 0);
  const heartbeat = fixtureDatabase(presenceFile, db => db.prepare('SELECT seat,at FROM heartbeat').all());
  assert.equal(heartbeat.length, 1, 'this disposable fixture has only its coordinator heartbeat');
  assert.ok(Date.now() - Date.parse(heartbeat[0].at) < 60_000, 'the first write has a genuinely fresh production heartbeat'); // budget: declared production freshness boundary from seat-presence.js, not a latency target.
  const agedAt = new Date(Date.now() - 120_000).toISOString();
  fixtureDatabase(presenceFile, db => assert.equal(db.prepare('UPDATE heartbeat SET at=? WHERE seat=?').run(agedAt, heartbeat[0].seat).changes, 1)); // budget: derived fixture age is two production refresh intervals; this equality counts SQLite rows, not elapsed time.
  const aged = await box.cliWithSnapshotTrace(1, 'status');
  t.diagnostic('publish aged presentation: ' + JSON.stringify(traceEvidence(aged)));
  assert.equal(aged.code, 0);
  assert.equal(fixtureDatabase(presenceFile, db => db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(heartbeat[0].seat).at), agedAt,
    'the real status read publishes the aged presentation without refreshing its heartbeat');
  const stale = await box.cliWithSnapshotTrace(1, 'shout', box.lane, staleText);
  t.diagnostic('stale write: ' + JSON.stringify(traceEvidence(stale)));
  assert.equal(stale.code, 0);
  const counts = { fresh: operationCount(boardFile, freshText), stale: operationCount(boardFile, staleText) };
  t.diagnostic('requested operation counts: ' + JSON.stringify(counts));
  assert.deepEqual(counts, { fresh: 1, stale: 1 }, 'each real CLI operation is recorded exactly once');
  assert.equal(fresh.snapshotTrace.length, 1, 'fresh presence needs only the ordered checkpoint');
  assert.equal(aged.snapshotTrace.length, 1, 'the changed aged presentation is published once before the second write');
  assert.equal(stale.snapshotTrace.length, 1, 'the ordered checkpoint includes the refreshed presence without another upload');
  // The write publishes through the command's one end-of-command sync, not through a second presence upload.
  assert.ok(stale.snapshotTrace[0].callers.some(caller => caller.includes('retrySync')), 'the sole checkpoint comes from the command\'s sync after the write: ' + JSON.stringify(stale.snapshotTrace[0].callers));
  const observedAt = fixtureDatabase(presenceFile, db => db.prepare('SELECT at FROM heartbeat WHERE seat=?').get(heartbeat[0].seat).at);
  assert.notEqual(observedAt, agedAt, 'the successful native write really refreshed the heartbeat');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const stateResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stateResponse.status, 200, 'the ordinary linked device can read its acknowledged checkpoint');
  const saved = (await stateResponse.json()).state;
  assert.equal(saved.sequence, stale.snapshotTrace[0].sequence);
  const opened = await unseal(decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim()), Buffer.from(saved.sealed, 'base64url'), {
    boardId: link.board, kind: 'snapshot', sequence: saved.sequence,
  });
  const plaintext = opened[0] === 0x1f && opened[1] === 0x8b ? gunzipSync(opened) : opened;
  const snapshot = JSON.parse(new TextDecoder().decode(plaintext));
  const published = snapshot.presentation.state.agents.find(agent => agent.agent_id === 'coordinator');
  assert.equal(published.heartbeatAt, observedAt, 'the one uploaded checkpoint contains the refreshed heartbeat');
  for (const result of [fresh, aged, stale]) for (const entry of result.snapshotTrace) {
    assert.equal(entry.status, 200);
    assert.equal(entry.abort, null, 'a presentation refresh is not a timed-out transport retry');
  }
});

test('a gone seat claim returns to the queue with a note [B3,B5,H16]', async t => {
  const { goneClaimFixture } = await import('../../../tests/fixtures/presence.js');
  const { exportBoard, importBoard } = await import('../../../../../packages/store/index.js');
  const { applyEngineMove } = await import('../../../../../packages/state/index.js');
  const { GONE_CLAIM_ENGINE } = await import('../../../../../packages/state/light.js');
  const { nativeBoardPorts } = await import('../../../../lib/index.js');
  const { relaySenderProblem } = nativeBoardPorts().enginePorts;
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
  const f = goneClaimFixture(t);
  const id = f.claim();
  const lastSeen = store.agentById(f.board, f.owner).heartbeatAt;
  const prefix = exportBoard(f.board);
  f.advance(1_800_000 - 1);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'one millisecond before gone retains the two-hour lease');
  f.advance(1);
  await f.scan();
  const released = store.getItem(f.board, id);
  assert.equal(released.item_status, 'open');
  assert.equal(released.item_owner, null);
  assert.equal(released.item_lease_until, null);
  const event = store.events(f.board, { itemId: id }).at(-1);
  const detail = JSON.parse(event.event_detail);
  assert.equal(event.event_kind, 'release');
  assert.equal(event.event_by, 'coordinator', 'maintenance never impersonates the holder');
  assert.deepEqual(detail.goneSeat, { seat: f.owner, lastSeen });
  assert.equal(detail.reasonCode, 'BLOCKED');
  assert.ok(detail.reason.includes(f.owner) && detail.reason.includes(lastSeen));
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'web' }).item.item_id, id);
  await f.scan();
  assert.equal(f.moves.length, 1, 'maintenance is idempotent after the ordinary release');
  const replica = fixtureBoard(t, { clock: f.clock });
  importBoard(replica, prefix);
  heartbeatSeat(replica, f.owner);
  assert.equal(store.agentById(replica, f.owner).presence, 'live');
  const [{ move, options }] = f.moves;
  assert.ok(move.engine >= GONE_CLAIM_ENGINE);
  assert.throws(() => applyEngineMove(replica, { ...move, engine: GONE_CLAIM_ENGINE - 1 }, options), error => error.code === 'RELAY_MOVE');
  assert.equal(relaySenderProblem(move, { kind: 'agent', userId: 'fixture-user', agent: f.other }, 'move').code, 'RELAY_SENDER_MISMATCH');
  assert.equal(relaySenderProblem(move, { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' }, 'move'), null);
  assert.equal(applyEngineMove(replica, move, options).error, undefined);
  assert.equal(store.getItem(replica, id).item_status, 'open', 'replay uses frozen observed evidence, not replica-local heartbeat');
});

test('gone claim maintenance is opt-in and preserves recent seats and ordinary authority [B3,B5,H2]', async t => {
  const { goneClaimFixture } = await import('../../../tests/fixtures/presence.js');
  const { heartbeatSeat } = await import('../../../../../packages/store/index.js');
  const { defaults, loadConfig, configFromSource } = await import('../../../../../packages/config/index.js');
  const f = goneClaimFixture(t);
  const id = f.claim();
  assert.equal(defaults().claims.releaseGone, false);
  assert.equal(loadConfig(f.box.repo).claims.releaseGone, false);
  assert.equal(configFromSource('{"claims":{"releaseGone":true}}').claims.releaseGone, true);
  assert.throws(() => configFromSource('{"claims":{"releaseGone":"true"}}'), error => error.code === 'BAD_CONFIG');
  f.advance(1_800_000);
  await f.scan(false);
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'off preserves the ordinary lease');
  await f.scan(true, f.other);
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'a peer cannot perform coordinator maintenance');
  heartbeatSeat(f.board, f.owner);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'active holder is retained');
  f.advance(1_800_000 - 1);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'claimed', 'recent heartbeat resets the exact gone boundary');
  const observation = { seat: f.owner, lastSeen: store.agentById(f.board, f.owner).heartbeatAt };
  assert.throws(() => store.release(f.board, id, f.other, '', observation, 'BLOCKED'), error => error.code === 'NOT_YOURS');
  assert.throws(() => store.release(f.board, id, 'coordinator', '', observation, 'BLOCKED'), error => error.code === 'NOT_YOURS');
  f.advance(1);
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'Outside approval is pending' });
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.equal(store.itemHold(f.board, id).item_hold_reason, 'Outside approval is pending');
  assert.throws(() => store.claim(f.board, id, { agentId: f.other, lane: 'web', leaseMs: 7_200_000, freeze: f.freeze }), error => error.code === 'ITEM_HELD');
});

test('gone maintenance leaves unknown imported holders and submitted reviews alone [B3,V1,H16]', async t => {
  const { goneClaimFixture } = await import('../../../tests/fixtures/presence.js');
  const { exportBoard, importBoard } = await import('../../../../../packages/store/index.js');
  const { releaseGoneClaims } = await import('../../../../../packages/sentinels/index.js');
  const { submitFixture } = await import('../../../tests/fixtures/board/submit.js');
  const f = goneClaimFixture(t);
  const id = f.claim();
  const replica = fixtureBoard(t, { clock: f.clock });
  importBoard(replica, exportBoard(f.board));
  f.advance(1_800_000);
  let attempted = false;
  await releaseGoneClaims({ config: { claims: { releaseGone: true } } }, replica, { id: 'coordinator' }, async () => { attempted = true; });
  assert.equal(attempted, false, 'missing local/imported observations are not authority');
  assert.equal(store.getItem(replica, id).item_status, 'claimed');
  // Synthetic submission metadata sets up lifecycle state only; it is not a gate proof.
  submitFixture(f.board, id, { agentId: f.owner, commit: 'a'.repeat(40), tree: 'fixture-tree' });
  assert.throws(() => store.reserveReview(f.board, id, { agentId: f.owner, leaseMs: 7_200_000, policy: 'any' }), error => error.code === 'SELF_VERIFY');
  store.reserveReview(f.board, id, { agentId: f.other, leaseMs: 7_200_000, policy: 'any' });
  f.advance(1_800_000);
  await f.scan();
  assert.equal(store.getItem(f.board, id).item_status, 'submitted');
  assert.equal(store.getItem(f.board, id).item_review_by, f.other);
  assert.equal(f.moves.length, 0, 'gone build maintenance never frees an independent review reservation');
});

test('native and ordered gone releases retain coded evidence and historical event shape [B3,C7,H16]', async t => {
  const { goneClaimFixture } = await import('../../../tests/fixtures/presence.js');
  const { applyEngineMove, prepareEngineMove } = await import('../../../../../packages/state/index.js');
  const { GONE_CLAIM_ENGINE } = await import('../../../../../packages/state/light.js');
  const { RELEASE_REASONS_ENGINE } = await import('../../../../../packages/state/light.js');
  for (const mode of ['native', 'ordered', 'historical']) {
    const f = goneClaimFixture(t);
    store.register(f.board, { lane: 'coordinator', path: f.box.repo, model: 'Coded maintenance fixture' });
    const id = f.claim();
    const observation = { seat: f.owner, lastSeen: store.agentById(f.board, f.owner).heartbeatAt };
    f.advance(1_800_000);
    const before = store.getItem(f.board, id), events = store.events(f.board);
    for (const code of [undefined, 'NOPE']) {
      assert.throws(() => store.release(f.board, id, 'coordinator', '', observation, code), { code: 'RELEASE_REASON' });
      assert.deepEqual(store.getItem(f.board, id), before);
      assert.deepEqual(store.events(f.board), events);
    }
    assert.throws(() => store.release(f.board, id, f.other, '', observation, 'BLOCKED'), { code: 'NOT_YOURS' });
    assert.deepEqual(store.events(f.board), events, 'a real code cannot grant maintenance authority');
    const args = [id, 'coordinator', '', observation, 'BLOCKED'];
    const move = prepareEngineMove(f.board, 'release', args);
    assert.ok(move.engine >= RELEASE_REASONS_ENGINE);
    const options = { sequence: 1, at: f.clock.now().toISOString() };
    assert.throws(() => applyEngineMove(f.board, { ...move, engine: GONE_CLAIM_ENGINE }, options), { code: 'RELAY_MOVE' });
    assert.deepEqual(store.getItem(f.board, id), before, 'an old writer cannot drop the supplied code');
    if (mode === 'native') store.release(f.board, id, 'coordinator', '', observation, 'BLOCKED');
    else {
      const selected = mode === 'historical'
        ? { ...prepareEngineMove(f.board, 'release', args.slice(0, 4)), engine: GONE_CLAIM_ENGINE }
        : move;
      const outcome = applyEngineMove(f.board, selected, options);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(applyEngineMove(f.board, selected, options), outcome, 'the same dual-argument move replays once');
    }
    assert.equal(store.getItem(f.board, id).item_status, 'open');
    const detail = JSON.parse(store.events(f.board, { itemId: id }).at(-1).event_detail);
    assert.deepEqual(detail.goneSeat, observation);
    assert.equal(detail.model, 'Coded maintenance fixture');
    assert.deepEqual(Object.keys(detail).sort(), mode === 'historical' ? ['goneSeat', 'model', 'reason'] : ['goneSeat', 'model', 'reason', 'reasonCode']);
    if (mode !== 'historical') assert.equal(detail.reasonCode, 'BLOCKED');
  }
});
