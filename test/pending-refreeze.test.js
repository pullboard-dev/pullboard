/** Pending coordinator corrections keep a live claim until its frozen bar is adopted [V2,H16]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();

/** Parse one private CLI refusal and require its exact next-step suffix. */
function refusal(result, code, itemId, pendingFields) {
  assert.equal(result.code, 1, `${result.out}${result.err}`);
  const document = JSON.parse(result.out);
  assert.equal(document.error.code, code);
  if (code === 'PENDING_REFREEZE') {
    assert.ok(Array.isArray(pendingFields) && pendingFields.length > 0, 'pending refusals name their expected corrected fields');
    assert.ok(document.error.message.includes(`pending ${[...pendingFields].sort().join(' and ')} correction`), document.error.message);
    assert.ok(document.error.message.endsWith(`next: pullboard refreeze ${itemId}`), document.error.message);
  }
  return document.error;
}

test("the coordinator corrects a claimed item's criterion without release [V2]", (t) => {
  const box = e2e.project('true');
  t.after(e2e.cleanup);
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));

  const added = box.run(box.repo, 'add', 'web', 'Correct a live bar', '--specs', 'G1', '--route', 'strong', '--criterion', 'the original criterion', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claim = box.run(box.web, 'claim', String(id), '--json');
  assert.equal(claim.code, 0, claim.err || claim.out);
  const before = store.getItem(board, id);

  const routeEdit = box.run(box.repo, 'edit', String(id), '--route', 'mid', '--json');
  assert.match(refusal(routeEdit, 'HELD', id).message, /change its route, criterion or check only while it is open/u);
  assert.equal(store.getItem(board, id).item_route, before.item_route, 'a claimed route remains unchanged after refusal');
  const agentEdit = box.run(box.web, 'edit', String(id), '--criterion', 'an agent cannot change the frozen bar', '--json');
  assert.match(refusal(agentEdit, 'HELD', id).message, /only the coordinator may edit it while held/u);

  const corrected = box.run(box.repo, 'edit', String(id), '--criterion', 'the corrected criterion', '--check', 'true && true', '--json');
  assert.equal(corrected.code, 0, corrected.err || corrected.out);
  const pending = store.getItem(board, id);
  assert.equal(pending.item_criterion, 'the corrected criterion');
  assert.equal(pending.item_check, 'true && true');
  assert.equal(pending.item_frozen_digest, before.item_frozen_digest, 'the original frozen bar remains until refreeze');
  assert.equal(pending.item_owner, before.item_owner);
  assert.equal(pending.item_lease_until, before.item_lease_until);
  const notice = store.inbox(board, before.item_owner).find((entry) => entry.shout_text.includes(`pending criterion and check correction for #${id}`));
  assert.ok(notice, 'the holder receives the pending correction and refreeze command');
  assert.ok(notice.shout_text.endsWith(`next: pullboard refreeze ${id}`));

  refusal(box.run(box.web, 'claim', String(id), '--json'), 'PENDING_REFREEZE', id, ['criterion', 'check']);
  refusal(box.run(box.web, 'submit', String(id), '--json'), 'PENDING_REFREEZE', id, ['criterion', 'check']);
  assert.equal(store.getItem(board, id).item_claim_head, before.item_claim_head, 'neither refusal changes the claim base');

  const refrozen = box.run(box.web, 'refreeze', String(id), '--json');
  assert.equal(refrozen.code, 0, refrozen.err || refrozen.out);
  const result = JSON.parse(refrozen.out);
  assert.equal(result.retainedClaim, true);
  const adopted = store.getItem(board, id);
  assert.equal(adopted.item_status, 'claimed');
  assert.equal(adopted.item_owner, before.item_owner);
  assert.equal(adopted.item_lease_until, before.item_lease_until);
  assert.equal(adopted.item_claim_head, before.item_claim_head);
  assert.deepEqual(JSON.parse(adopted.item_frozen), {
    title: 'Correct a live bar',
    criterion: 'the corrected criterion',
    check: 'true && true',
    rows: [{ id: 'G1', text: 'The page renders.', gate: 'web test' }],
    policy: { version: 1, commit: JSON.parse(before.item_frozen).policy.commit, verify: { policy: 'any', family: 'off' } },
  });

  const page = join(box.web, 'web', 'page.js');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(page, 'export const corrected = true;\n');
  box.git(box.web, 'add', 'web/page.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): use corrected criterion [G1]');
  const submitted = box.run(box.web, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const finalItem = store.getItem(board, id);
  assert.equal(finalItem.item_status, 'submitted');
  assert.equal(finalItem.item_check, 'true && true');
  assert.equal(JSON.parse(finalItem.item_frozen).criterion, 'the corrected criterion');
  assert.equal(finalItem.item_commit, box.git(box.web, 'rev-parse', 'HEAD'));

  const checkAdd = box.run(box.repo, 'add', 'web', 'Correct only a check', '--specs', 'G1', '--criterion', 'unchanged criterion', '--check', 'true', '--json');
  assert.equal(checkAdd.code, 0, checkAdd.err || checkAdd.out);
  const checkId = JSON.parse(checkAdd.out).item.item_id;
  const checkClaim = box.run(box.web, 'claim', String(checkId), '--json');
  assert.equal(checkClaim.code, 0, checkClaim.err || checkClaim.out);
  const checkBefore = store.getItem(board, checkId);
  const checkEdit = box.run(box.repo, 'edit', String(checkId), '--check', 'true && true', '--json');
  assert.equal(checkEdit.code, 0, checkEdit.err || checkEdit.out);
  const checkPending = store.getItem(board, checkId);
  assert.equal(checkPending.item_criterion, checkBefore.item_criterion);
  assert.equal(checkPending.item_check, 'true && true');
  assert.equal(checkPending.item_frozen_digest, checkBefore.item_frozen_digest);
  assert.equal(checkPending.item_owner, checkBefore.item_owner);
  assert.deepEqual(store.pendingRefreeze(board, checkId), ['check']);
  const checkNotice = store.inbox(board, checkBefore.item_owner).find((entry) => entry.shout_text.includes(`pending check correction for #${checkId}`));
  assert.ok(checkNotice, 'the holder is told that the check correction needs refreezing');
  assert.ok(checkNotice.shout_text.endsWith(`next: pullboard refreeze ${checkId}`));
  refusal(box.run(box.web, 'claim', String(checkId), '--json'), 'PENDING_REFREEZE', checkId, ['check']);
  refusal(box.run(box.web, 'submit', String(checkId), '--json'), 'PENDING_REFREEZE', checkId, ['check']);
  const checkRefreeze = box.run(box.web, 'refreeze', String(checkId), '--json');
  assert.equal(checkRefreeze.code, 0, checkRefreeze.err || checkRefreeze.out);
  assert.equal(JSON.parse(checkRefreeze.out).retainedClaim, true);
  assert.equal(store.getItem(board, checkId).item_owner, checkBefore.item_owner);
  assert.equal(store.getItem(board, checkId).item_status, 'claimed');
  assert.equal(store.pendingRefreeze(board, checkId).length, 0);

});

test('ordered refreeze corrections retain engine-7 history and engine-8 live claims [V2,H16]', (t) => {
  const replicaDirectory = mkdtempSync(join(tmpdir(), 'pullboard-refreeze-replicas-'));
  const replicaBoards = [];
  const legacyClock = '2026-10-10T12:00:00.000Z';
  const currentClock = '2026-10-10T13:00:00.000Z';
  /** Open and track one isolated file-backed replica with its deterministic clock. */
  const openBoardWithClock = (name, at) => {
    const board = store.openBoard(join(replicaDirectory, `${name}.sqlite`), { now: () => new Date(at) });
    replicaBoards.push(board);
    return board;
  };
  t.after(() => {
    for (const replica of replicaBoards) store.closeBoard(replica);
    rmSync(replicaDirectory, { recursive: true, force: true });
  });
  const legacy = openBoardWithClock('legacy', legacyClock);
  store.register(legacy, { lane: 'coordinator', path: '/legacy/coordinator' });
  store.register(legacy, { lane: 'web', path: '/legacy/web' });
  const legacyId = store.addItem(legacy, {
    by: 'web-1', lane: 'web', title: 'Legacy claim', route: 'strong', criterion: 'legacy criterion',
    brief: e2e.LIGHT_BRIEF,
  });
  const legacyReplica = openBoardWithClock('legacy-replica', legacyClock);
  importBoard(legacyReplica, exportBoard(legacy));
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
  const coordinatorSender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  /** Replay one move on both real board replicas and compare its receipt and event history. */
  const applyBoth = (move, sequence, moveSender = sender) => {
    const receipt = applyRelayMove(legacy, move, { sequence, at: `2026-10-10T12:00:0${sequence}.000Z`, sender: moveSender, kind: 'move' });
    assert.deepEqual(applyRelayMove(legacyReplica, move, { sequence, at: `2026-10-10T12:00:0${sequence}.000Z`, sender: moveSender, kind: 'move' }), receipt);
    assert.deepEqual(store.events(legacyReplica), store.events(legacy), 'replicas retain the same ordered event history');
    return receipt;
  };
  const legacyClaim = prepareEngineMove(legacy, 'claim', [legacyId, {
    agentId: 'web-1', lane: 'web', leaseMs: 60_000, head: 'a'.repeat(40),
    freeze: (item) => ({ text: item.item_criterion, digest: 'a'.repeat(64) }),
  }]);
  legacyClaim.engine = 7;
  applyBoth(legacyClaim, 1);
  const legacyBrief = `${e2e.LIGHT_BRIEF.trim()}\nExtra recovery evidence.\n`;
  const legacyEdit = prepareEngineMove(legacy, 'editItem', [legacyId, { agentId: 'web-1', brief: legacyBrief }]);
  legacyEdit.engine = 7;
  assert.equal(applyBoth(legacyEdit, 2).error, undefined, 'engine 7 still permits the creator brief edit');
  assert.equal(store.getItem(legacy, legacyId).item_brief, legacyBrief.trim(),
    'engine 7 retains its historical creator edit of the brief while claimed');
  const legacyUnauthorized = prepareEngineMove(legacy, 'editItem', [legacyId, { agentId: 'other-agent', criterion: 'unauthorized' }]);
  legacyUnauthorized.engine = 7;
  assert.equal(applyBoth(legacyUnauthorized, 3, { kind: 'agent', userId: 'fixture-user', agent: 'other-agent' }).error.code, 'NOT_YOURS',
    'engine 7 retains its prior refusal precedence for a non-owner');
  const legacyRefreezeMove = prepareEngineMove(legacy, 'refreeze', [legacyId, {
    agentId: 'coordinator', freeze: () => ({ text: 'legacy-frozen-again', digest: 'b'.repeat(64) }),
  }]);
  legacyRefreezeMove.engine = 7;
  const legacyRefreeze = applyBoth(legacyRefreezeMove, 4, coordinatorSender);
  assert.deepEqual(legacyRefreeze.result, { before: 'a'.repeat(64), after: 'b'.repeat(64) });
  assert.deepEqual(Object.keys(legacyRefreeze.result).sort(), ['after', 'before']);
  assert.equal(store.getItem(legacy, legacyId).item_status, 'open', 'engine 7 keeps the original release-on-refreeze behavior');
  const unknownLegacyRefreeze = structuredClone(legacyRefreezeMove);
  unknownLegacyRefreeze.id = 'legacy-unknown-refreeze';
  unknownLegacyRefreeze.args[0] = 999999;
  unknownLegacyRefreeze.args[1].agentId = 'web-1';
  assert.equal(applyBoth(unknownLegacyRefreeze, 5).error.code, 'COORDINATOR_ONLY',
    'engine 7 checks coordinator authority before looking up an unknown refreeze item');

  const current = openBoardWithClock('current', currentClock);
  store.register(current, { lane: 'coordinator', path: '/current/coordinator' });
  store.register(current, { lane: 'web', path: '/current/web' });
  const currentId = store.addItem(current, {
    by: 'coordinator', lane: 'web', title: 'Current ordered correction', route: 'mid',
    criterion: 'original current criterion', brief: e2e.LIGHT_BRIEF, check: 'true',
  });
  const currentReplica = openBoardWithClock('current-replica', currentClock);
  importBoard(currentReplica, exportBoard(current));
  /** Replay one engine-8 move on both replicas and require identical ordered results. */
  const applyCurrentBoth = (move, sequence, moveSender) => {
    const at = `2026-10-10T13:00:0${sequence}.000Z`;
    const receipt = applyRelayMove(current, move, { sequence, at, sender: moveSender, kind: 'move' });
    assert.deepEqual(applyRelayMove(currentReplica, move, { sequence, at, sender: moveSender, kind: 'move' }), receipt);
    assert.deepEqual(store.events(currentReplica), store.events(current), 'both replicas agree after each current-engine move');
    return receipt;
  };
  const currentClaim = prepareEngineMove(current, 'claim', [currentId, {
    agentId: 'web-1', lane: 'web', leaseMs: 60_000, head: 'b'.repeat(40),
    freeze: (item) => ({ text: item.item_criterion, digest: 'c'.repeat(64) }),
  }]);
  applyCurrentBoth(currentClaim, 1, sender);
  const correction = prepareEngineMove(current, 'editItem', [currentId, {
    agentId: 'coordinator', criterion: 'corrected by an ordered coordinator move',
  }]);
  applyCurrentBoth(correction, 2, coordinatorSender);
  for (const replica of [current, currentReplica]) {
    assert.equal(store.getItem(replica, currentId).item_status, 'claimed');
    assert.equal(store.pendingRefreeze(replica, currentId).join(','), 'criterion');
    assert.equal(store.getItem(replica, currentId).item_frozen_digest, 'c'.repeat(64));
  }
  const currentRefreeze = prepareEngineMove(current, 'refreeze', [currentId, {
    agentId: 'web-1', freeze: () => ({ text: 'corrected by an ordered coordinator move', digest: 'd'.repeat(64) }),
  }]);
  const retained = applyCurrentBoth(currentRefreeze, 3, sender);
  assert.equal(retained.result.retainedClaim, true);
  for (const replica of [current, currentReplica]) {
    assert.equal(store.getItem(replica, currentId).item_status, 'claimed');
    assert.equal(store.pendingRefreeze(replica, currentId).length, 0);
    assert.equal(store.getItem(replica, currentId).item_frozen_digest, 'd'.repeat(64));
  }
});
