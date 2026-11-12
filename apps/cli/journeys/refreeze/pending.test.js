/** @pullboard-test-loads packages/store/src/shell/board.js packages/state/src/shell/engine.js src/exchange.js packages/state/src/shell/machine.js */
/** Pending coordinator corrections keep a live claim until its frozen bar is adopted [V2,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  appliedSequence,
  applyRelayMove,
  engineReceipt,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  AUTO_ESCALATE_ENGINE,
  ENGINE_VERSION,
  STRONG_REJECTION_NOTICE_ENGINE,
  VERIFIER_STANDING_ENGINE,
} from '../../../../packages/state/index.js';
import { MILESTONE_SHIP_ENGINE } from '../../../../packages/state/src/logic/move/constants.js';
import { WITHDRAW_MILESTONE_ENGINE } from '../../../../packages/state/light.js';
import { BOARD_SENTINEL_ENGINE } from '../../../../packages/sentinels/index.js';
import { RIGOR_NOTICE_ENGINE } from '../../../../packages/store/index.js';
import { HEALTH_SENTINEL_ENGINE } from '../../../../packages/store/index.js';
import { CONFLICT_ENGINE } from '../../../../packages/state/light.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

/** Remove only the writer's engine marker before comparing otherwise identical replay exports. */
function withoutEngineMarker(snapshot) {
  return {
    ...snapshot,
    tables: {
      ...snapshot.tables,
      board_meta: snapshot.tables.board_meta.filter((row) => row.meta_key !== 'relay_engine_version'),
    },
  };
}

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

test("clause 1: the coordinator corrects a claimed item's criterion without release [V2]", async (t) => {
  const box = e2e.project('true');
  t.after(e2e.cleanup);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));

  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Correct a live bar', '--specs', 'G1', '--route', 'strong', '--criterion', 'the original criterion', '--check', 'true', '--json'));
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const claim = (await box.runLocal(box.web, 'claim', String(id), '--json'));
  assert.equal(claim.code, 0, claim.err || claim.out);
  const before = store.getItem(board, id);

  const routeEdit = (await box.runLocal(box.repo, 'edit', String(id), '--route', 'mid', '--json'));
  assert.match(refusal(routeEdit, 'HELD', id).message, /change its route, criterion or check only while it is open/u);
  assert.equal(store.getItem(board, id).item_route, before.item_route, 'a claimed route remains unchanged after refusal');
  const agentEdit = (await box.runLocal(box.web, 'edit', String(id), '--criterion', 'an agent cannot change the frozen bar', '--json'));
  assert.match(refusal(agentEdit, 'HELD', id).message, /only the coordinator may edit it while held/u);

  const corrected = (await box.runLocal(box.repo, 'edit', String(id), '--criterion', 'the corrected criterion', '--check', 'true && true', '--reason', 'the fixture corrects its bar', '--json'));
  assert.equal(corrected.code, 0, corrected.err || corrected.out);
  const adopted = store.getItem(board, id);
  assert.equal(adopted.item_criterion, 'the corrected criterion');
  assert.equal(adopted.item_check, 'true && true');
  assert.notEqual(adopted.item_frozen_digest, before.item_frozen_digest, 'the same edit adopts its corrected bar');
  assert.equal(adopted.item_status, 'claimed');
  assert.equal(adopted.item_owner, before.item_owner);
  assert.equal(adopted.item_lease_until, before.item_lease_until);
  assert.equal(adopted.item_claim_head, before.item_claim_head);
  assert.deepEqual(store.pendingRefreeze(board, id), []);
  const notice = store.inbox(board, before.item_owner).find(entry => entry.shout_text.includes(`corrected #${id}`));
  assert.ok(notice, 'the holder receives the effective correction in the same move');
  assert.doesNotMatch(notice.shout_text, /pending|refreeze/u);
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0, 'renewal has no pending-bar refusal');
  assert.deepEqual(JSON.parse(adopted.item_frozen), {
    title: 'Correct a live bar', criterion: 'the corrected criterion', check: 'true && true',
    rows: [{ id: 'G1', text: 'The page renders.', gate: 'web test' }],
  }, 'the corrected freeze is the bar alone, no policy pin [B4]');

  const page = join(box.web, 'web', 'page.js');
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(page, 'export const corrected = true;\n');
  box.git(box.web, 'add', 'web/page.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): use corrected criterion [G1]');
  const submitted = (await box.runLocal(box.web, 'submit', String(id), '--json'));
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const finalItem = store.getItem(board, id);
  assert.equal(finalItem.item_status, 'submitted');
  assert.equal(finalItem.item_check, 'true && true');
  assert.equal(JSON.parse(finalItem.item_frozen).criterion, 'the corrected criterion');
  assert.equal(finalItem.item_commit, box.git(box.web, 'rev-parse', 'HEAD'));

  const checkAdd = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Correct only a check', '--specs', 'G1', '--route', 'strong', '--criterion', 'unchanged criterion', '--check', 'true', '--json'));
  assert.equal(checkAdd.code, 0, checkAdd.err || checkAdd.out);
  const checkId = JSON.parse(checkAdd.out).item.item_id;
  const checkClaim = (await box.runLocal(box.web, 'claim', String(checkId), '--json'));
  assert.equal(checkClaim.code, 0, checkClaim.err || checkClaim.out);
  const checkBefore = store.getItem(board, checkId);
  const checkEdit = (await box.runLocal(box.repo, 'edit', String(checkId), '--check', 'true && true', '--reason', 'the fixture corrects its bar', '--json'));
  assert.equal(checkEdit.code, 0, checkEdit.err || checkEdit.out);
  const checkPending = store.getItem(board, checkId);
  assert.equal(checkPending.item_criterion, checkBefore.item_criterion);
  assert.equal(checkPending.item_check, 'true && true');
  assert.notEqual(checkPending.item_frozen_digest, checkBefore.item_frozen_digest);
  assert.equal(checkPending.item_owner, checkBefore.item_owner);
  assert.deepEqual(store.pendingRefreeze(board, checkId), []);
  assert.equal(JSON.parse(checkPending.item_frozen).check, 'true && true');
  const checkNotice = store.inbox(board, checkBefore.item_owner).find(entry => entry.shout_text.includes(`corrected #${checkId}`));
  assert.ok(checkNotice, 'a check-only correction also notifies the holder');
  assert.doesNotMatch(checkNotice.shout_text, /pending|refreeze/u);
  assert.equal((await box.runLocal(box.web, 'claim', String(checkId), '--json')).code, 0);
  assert.equal(store.getItem(board, checkId).item_status, 'claimed');

});

test("edit adds and clears an item's dependencies [B3,V2]", async (t) => {
  const box = e2e.project('true');
  t.after(e2e.cleanup);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  t.after(() => store.closeBoard(board));
  /** Add one independent item through the real CLI and return its public id. */
  const add = async (title, route = 'mid') => {
    const result = (await fixtureAdd(box.runLocal, box.repo, 'web', title, '--route', route, '--criterion', title,
      '--brief', 'Files: web/dependencies.js\nChange: update dependency links\nTest: records dependency edits', '--check', 'true', '--json'));
    assert.equal(result.code, 0, result.err || result.out);
    return JSON.parse(result.out).item.item_id;
  };
  const first = (await add('First dependency'));
  const second = (await add('Second dependency'));
  const target = (await add('Dependency target'));

  const added = (await box.runLocal(box.repo, 'edit', String(target), '--after', `${first},${second}`, '--json'));
  assert.equal(added.code, 0, added.err || added.out);
  assert.equal(store.getItem(board, target).item_after, `${first},${second}`, 'edit stores both dependency ids in order');
  const addEvent = store.events(board, { itemId: target }).findLast((event) => event.event_kind === 'edit');
  assert.deepEqual(JSON.parse(addEvent.event_detail).after, [first, second], 'history records the dependency replacement');

  const cleared = (await box.runLocal(box.repo, 'edit', String(target), '--after', 'none', '--json'));
  assert.equal(cleared.code, 0, cleared.err || cleared.out);
  assert.equal(store.getItem(board, target).item_after, '', 'none clears all dependencies');
  const clearEvent = store.events(board, { itemId: target }).findLast((event) => event.event_kind === 'edit');
  assert.deepEqual(JSON.parse(clearEvent.event_detail).after, [], 'history records a clear distinctly from an omitted edit');

  const unchanged = store.getItem(board, target);
  const eventCount = store.events(board, { itemId: target }).length;
  refusal((await box.runLocal(box.repo, 'edit', String(target), '--after', '999999', '--json')), 'NO_ITEM');
  assert.equal(store.getItem(board, target).item_after, unchanged.item_after, 'a missing dependency leaves the item unchanged');
  assert.equal(store.events(board, { itemId: target }).length, eventCount, 'a refused dependency creates no history event');

  assert.equal((await box.runLocal(box.repo, 'edit', String(first), '--after', String(second), '--json')).code, 0);
  const cycle = (await box.runLocal(box.repo, 'edit', String(second), '--after', String(first), '--json'));
  refusal(cycle, 'DEPENDENCY_CYCLE');
  assert.equal(store.getItem(board, second).item_after, '', 'a refused cycle leaves the edge unchanged');

  const claimed = (await add('Claimed dependency target'));
  const diagnosis = (await box.runLocal(box.repo, 'fact', String(claimed), 'diagnosis',
    'Files: web/dependencies.js Change: correct dependency edges without changing the frozen bar Test case: edit adds and clears an item\'s dependencies'));
  assert.equal(diagnosis.code, 0, diagnosis.err || diagnosis.out);
  const claim = (await box.runLocal(box.web, 'claim', String(claimed), '--json'));
  assert.equal(claim.code, 0, claim.err || claim.out);
  const beforeCorrection = store.getItem(board, claimed);
  const correction = (await box.runLocal(box.repo, 'edit', String(claimed), '--after', String(first), '--json'));
  assert.equal(correction.code, 0, correction.err || correction.out);
  const pending = store.getItem(board, claimed);
  assert.equal(pending.item_after, String(first));
  assert.equal(pending.item_owner, beforeCorrection.item_owner);
  assert.equal(pending.item_lease_until, beforeCorrection.item_lease_until);
  assert.equal(pending.item_claim_head, beforeCorrection.item_claim_head);
  assert.equal(pending.item_frozen_digest, beforeCorrection.item_frozen_digest, 'dependencies change readiness without changing criterion bytes');
  assert.deepEqual(store.pendingRefreeze(board, claimed), []);
  const correctionEvent = store.events(board, { itemId: claimed }).findLast(event => event.event_kind === 'edit');
  assert.equal(JSON.parse(correctionEvent.event_detail).correctedFrozen, pending.item_frozen_digest);
  assert.deepEqual(JSON.parse(correctionEvent.event_detail).after, [first]);
  assert.ok(store.inbox(board, beforeCorrection.item_owner).some(entry =>
    entry.shout_text.includes(`corrected #${claimed}`) && !/pending|refreeze/u.test(entry.shout_text)));
  const blocked = (await box.runLocal(box.web, 'claim', String(claimed), '--json'));
  refusal(blocked, 'BLOCKED'); // A real prerequisite still applies; a pending-bar refusal never does.
  const clearClaimed = (await box.runLocal(box.repo, 'edit', String(claimed), '--after', 'none', '--json'));
  assert.equal(clearClaimed.code, 0, clearClaimed.err || clearClaimed.out);
  assert.deepEqual(store.pendingRefreeze(board, claimed), []);
  const renewed = (await box.runLocal(box.web, 'claim', String(claimed), '--json'));
  assert.equal(renewed.code, 0, `${renewed.out}\n${renewed.err}`);
  assert.equal(store.getItem(board, claimed).item_status, 'claimed');
  assert.equal(store.getItem(board, claimed).item_owner, beforeCorrection.item_owner);
});

/** Drop the derived pipeline stage that executables before c85ddac55a never computed. */
function withoutStage(row) {
  const { item_stage: _stage, ...rest } = row;
  return rest;
}

/** Exercise real older executables, rather than treating a retagged current move as an old client. */
async function checkDependencyLegacyClients(cleanup, directory, snapshot, target, add, clear) {
  for (const [version, reference] of [[7, 'v0.8.4'], [8, 'v0.8.6'], [9, '314ef28751c44c96186b337cc4ace0fd8bf33d42'], [10, 'v0.8.23']]) {
    const source = join(directory, `client-${version}`);
    mkdirSync(source);
    unpackRelease(reference, source);
    const legacyStore = await import(pathToFileURL(join(source, 'src/board.js')).href);
    const legacyEngine = await import(pathToFileURL(join(source, 'src/engine.js')).href);
    const legacyExchange = await import(pathToFileURL(join(source, 'src/exchange.js')).href);
    const legacyMachine = await import(pathToFileURL(join(source, 'src/machine.js')).href);
    assert.equal(legacyMachine.ENGINE_VERSION, version, 'the archived executable has the claimed engine');
    const old = legacyStore.openBoard(join(directory, `client-${version}.sqlite`));
    const current = openBoard(join(directory, `current-from-${version}.sqlite`));
    cleanup.push(() => { legacyStore.closeBoard(old); store.closeBoard(current); });
    legacyExchange.importBoard(old, snapshot);
    importBoard(current, snapshot);
    const ordinary = legacyEngine.prepareEngineMove(old, 'editItem', [target, {
      agentId: 'coordinator', brief: `Ordinary edit from actual engine ${version}.`,
    }], { id: `ordinary-client-${version}`, actor: 'coordinator' });
    const receipt = { sequence: 1, at: '2026-10-13T12:00:01.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };
    const oldResult = legacyEngine.applyRelayMove(old, ordinary, receipt);
    assert.equal(oldResult.error, undefined, JSON.stringify(oldResult));
    const result = applyRelayMove(current, ordinary, receipt);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(withoutStage(store.getItem(current, target)), legacyStore.getItem(old, target), 'ordinary legacy edits retain their exact row');
    assert.deepEqual(store.events(current), legacyStore.events(old), 'ordinary legacy edits retain their event history');
    const before = legacyExchange.exportBoard(old);
    for (const move of [add, clear]) {
      assert.throws(() => legacyEngine.applyRelayMove(old, move, { ...receipt, sequence: 2 }),
        (error) => error.code === 'ENGINE_VERSION', 'a genuine future envelope is refused by the actual old client');
      assert.deepEqual(legacyExchange.exportBoard(old), before, 'future refusal changes no board rows or replay metadata');
      assert.equal(legacyEngine.appliedSequence(old), 1, 'future refusal leaves the committed prefix unchanged');
    }
    if (version === 10) {
      for (const [index, move] of [add, clear].entries()) {
        const engine10Move = { ...move, id: `${move.id}-engine-10`, engine: 10 };
        const engine10Receipt = { ...receipt, sequence: index + 2 };
        const oldFeature = legacyEngine.applyRelayMove(old, engine10Move, engine10Receipt);
        const currentFeature = applyRelayMove(current, engine10Move, engine10Receipt);
        assert.equal(oldFeature.error, undefined, JSON.stringify(oldFeature));
        assert.deepEqual(currentFeature, oldFeature, 'the current writer reproduces engine 10 dependency additions and clears');
        assert.deepEqual(withoutStage(store.getItem(current, target)), legacyStore.getItem(old, target));
        assert.deepEqual(store.events(current), legacyStore.events(old), 'engine 10 and the current writer replay identical events');
        assert.equal(appliedSequence(current), legacyEngine.appliedSequence(old));
        assert.deepEqual(engineReceipt(current, engine10Move.id), legacyEngine.engineReceipt(old, engine10Move.id),
          'engine 10 and the current writer retain the same dependency-move receipts');
        const oldSnapshot = legacyExchange.exportBoard(old);
        const currentSnapshot = exportBoard(current);
        assert.equal(oldSnapshot.tables.board_meta.find((row) => row.meta_key === 'relay_engine_version').meta_value, '10');
        assert.equal(currentSnapshot.tables.board_meta.find((row) => row.meta_key === 'relay_engine_version').meta_value, String(ENGINE_VERSION));
        assert.deepEqual(withoutEngineMarker(currentSnapshot), withoutEngineMarker(oldSnapshot),
          'the sole snapshot difference is the intentionally newer writer-version marker');
      }
    }
  }
}

test('dependency edits replay the same on every engine [B3,V2,H16]', async (t) => {
  assert.equal(STRONG_REJECTION_NOTICE_ENGINE, 54, 'ceiling notices retain their allocated feature engine');
  assert.ok(ENGINE_VERSION >= STRONG_REJECTION_NOTICE_ENGINE, 'the current writer retains paired ceiling notices');
  assert.equal(AUTO_ESCALATE_ENGINE, 50, 'automatic escalation retains its allocated engine');
  assert.equal(WITHDRAW_MILESTONE_ENGINE, 51, 'withdraw retains its allocated feature engine');
  assert.ok(ENGINE_VERSION >= WITHDRAW_MILESTONE_ENGINE, 'the current writer includes the withdraw feature');
  assert.equal(CONFLICT_ENGINE, 52, 'trunk conflict retains its allocated feature engine');
  assert.ok(ENGINE_VERSION >= CONFLICT_ENGINE, 'the current writer retains trunk-conflict semantics');
  assert.ok(ENGINE_VERSION >= AUTO_ESCALATE_ENGINE, 'the current writer retains automatic escalation');
  assert.equal(MILESTONE_SHIP_ENGINE, 45, 'shipment retains its engine-45 meaning');
  assert.ok(ENGINE_VERSION >= MILESTONE_SHIP_ENGINE, 'the current writer retains all milestone shipment behavior');
  assert.ok(ENGINE_VERSION >= VERIFIER_STANDING_ENGINE, 'the current writer retains verifier standing');
  assert.ok(ENGINE_VERSION >= RIGOR_NOTICE_ENGINE, 'the next writer retains all recorded dependency-edit behavior');
  assert.ok(ENGINE_VERSION >= HEALTH_SENTINEL_ENGINE, 'the current writer retains the sentinel minimum and historical behavior');
  assert.equal(BOARD_SENTINEL_ENGINE, 56, 'board watches retain their allocated feature engine');
  assert.ok(ENGINE_VERSION >= BOARD_SENTINEL_ENGINE, 'the current writer retains board-watch semantics');
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-dependency-engines-'));
  const cleanup = [];
  t.after(() => {
    for (const close of cleanup) close();
    rmSync(directory, { recursive: true, force: true });
  });
  /** Open a private, file-backed SQLite board and optionally import its real snapshot. */
  function open(name, snapshot) {
    const board = openBoard(join(directory, `${name}.sqlite`));
    cleanup.push(() => store.closeBoard(board));
    if (snapshot) importBoard(board, snapshot);
    return board;
  }
  const seed = open('seed');
  store.register(seed, { lane: 'coordinator', path: '/dependency/coordinator' });
  /** Add independent real items to the seed board. */
  function addItem(title) {
    return store.addItem(seed, { by: 'coordinator', lane: 'web', title, criterion: title, brief: e2e.LIGHT_BRIEF });
  }
  const dependency = addItem('First prerequisite');
  const secondDependency = addItem('Second prerequisite');
  const target = addItem('Work with dependencies');
  const snapshot = exportBoard(seed);
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  const add = prepareEngineMove(seed, 'editItem', [target, { agentId: 'coordinator', after: [dependency, secondDependency] }],
    { id: 'dependency-add', actor: 'coordinator' });
  const clear = prepareEngineMove(seed, 'editItem', [target, { agentId: 'coordinator', after: [] }],
    { id: 'dependency-clear', actor: 'coordinator' });
  assert.equal(add.engine, ENGINE_VERSION);
  assert.equal(clear.engine, ENGINE_VERSION);
  const copies = [open('one', snapshot), open('two', snapshot)];
  for (const [index, move] of [add, clear].entries()) {
    const receipt = { sequence: index + 1, at: `2026-10-13T12:00:0${index + 1}.000Z`, sender, kind: 'move' };
    const results = copies.map((board) => applyRelayMove(board, move, receipt));
    assert.equal(results[0].error, undefined, JSON.stringify(results[0]));
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(exportBoard(copies[1]), exportBoard(copies[0]), 'current replicas have identical rows, events and prefix');
    assert.equal(store.getItem(copies[0], target).item_after, index === 0 ? `${dependency},${secondDependency}` : '');
    const event = store.events(copies[0], { itemId: target }).findLast((entry) => entry.event_kind === 'edit');
    assert.deepEqual(JSON.parse(event.event_detail).after, index === 0 ? [dependency, secondDependency] : []);
    assert.equal(appliedSequence(copies[0]), index + 1);
  }
  for (let version = 1; version < 10; version++) {
    const board = open(`tag-${version}`, snapshot);
    const ordinary = prepareEngineMove(board, 'editItem', [target, {
      agentId: 'coordinator', brief: `Ordinary historical engine ${version}.`, after: undefined,
    }], { id: `ordinary-tag-${version}`, actor: 'coordinator' });
    assert.equal(Object.hasOwn(ordinary.args[1], 'after'), false, 'an omitted CLI flag stays omitted on the wire');
    ordinary.engine = version;
    const receipt = { sequence: 1, at: '2026-10-13T12:00:01.000Z', sender, kind: 'move' };
    let result;
    assert.doesNotThrow(() => { result = applyRelayMove(board, ordinary, receipt); },
      `ordinary engine-${version} edits remain executable`);
    assert.equal(result.error, undefined, `ordinary engine-${version} edit remains valid: ${JSON.stringify(result)}`);
    const event = store.events(board, { itemId: target }).findLast((entry) => entry.event_kind === 'edit');
    assert.equal(Object.hasOwn(JSON.parse(event.event_detail), 'after'), false);
    const before = exportBoard(board);
    for (const move of [add, clear]) {
      assert.throws(() => applyRelayMove(board, { ...move, id: `${move.id}-tag-${version}`, engine: version },
        { ...receipt, sequence: 2 }), (error) => error.code === 'RELAY_MOVE' && /engine 10/u.test(error.message),
      'old-tag dependency fields, including empty-on-empty clears, cannot enter replay');
      assert.deepEqual(exportBoard(board), before, 'malformed old-tag moves change no row, event, receipt or cursor');
    }
    board.executionEngineVersion = version;
    try {
      for (const after of [[dependency], []]) {
        for (const edit of [store.validateItemEdit, store.editItem]) {
          assert.throws(() => edit(board, target, { agentId: 'coordinator', after }),
            (error) => error.code === 'ENGINE_VERSION' && error.message.includes(`engine ${version}`)
              && /engine 10/u.test(error.message) && /upgrade/iu.test(error.message));
          assert.deepEqual(exportBoard(board), before, 'direct and preflight old-engine dependency refusals change nothing');
        }
      }
    } finally { delete board.executionEngineVersion; }
  }
  for (const [index, after] of [null, '1', {}, [0], [-1], [1.5], [{}], ['1'], ['#1'], ['01'], ['1e0'], [' 1 ']].entries()) {
    const board = open(`invalid-${index}`, snapshot);
    const before = store.getItem(board, target);
    const beforeEvents = store.events(board);
    const move = prepareEngineMove(board, 'editItem', [target, { agentId: 'coordinator', after }],
      { id: `invalid-dependencies-${index}`, actor: 'coordinator' });
    let result;
    assert.doesNotThrow(() => { result = applyRelayMove(board, move, { sequence: 1, at: '2026-10-13T12:00:01.000Z', sender, kind: 'move' }); },
      'malformed dependencies are a typed operation refusal, never an unhandled exception');
    assert.equal(result.error?.code, 'BAD_DEPENDENCIES', 'malformed current dependencies yield a typed refusal');
    assert.deepEqual(store.getItem(board, target), before);
    assert.deepEqual(store.events(board), beforeEvents, 'a typed operation refusal creates no edit event');
    assert.equal(appliedSequence(board), 1, 'the refused current operation has one consumed receipt');
  }
  await checkDependencyLegacyClients(cleanup, directory, snapshot, target, add, clear);
});

test('ordered refreeze corrections retain engine-7 history and engine-8 live claims [V2,H16]', async (t) => {
  const replicaDirectory = mkdtempSync(join(tmpdir(), 'pullboard-refreeze-replicas-'));
  const replicaBoards = [];
  const legacyClock = '2026-10-10T12:00:00.000Z';
  const currentClock = '2026-10-10T13:00:00.000Z';
  /** Open and track one isolated file-backed replica with its deterministic clock. */
  const openBoardWithClock = (name, at) => {
    const board = openBoard(join(replicaDirectory, `${name}.sqlite`), { now: () => new Date(at) });
    replicaBoards.push(board);
    return board;
  };
  t.after(() => {
    for (const replica of replicaBoards) store.closeBoard(replica);
    rmSync(replicaDirectory, { recursive: true, force: true });
  });
  // Seed genuinely historical joins, rather than marking a modern seat and then downgrading its move.
  const legacySource = join(replicaDirectory, 'engine-7-source');
  mkdirSync(legacySource);
  unpackRelease('v0.8.4', legacySource);
  const legacyStore = await import(pathToFileURL(join(legacySource, 'src/board.js')).href);
  const legacyExchange = await import(pathToFileURL(join(legacySource, 'src/exchange.js')).href);
  const legacyMachine = await import(pathToFileURL(join(legacySource, 'src/machine.js')).href);
  assert.equal(legacyMachine.ENGINE_VERSION, 7, 'the registration writer is the actual engine-7 release');
  const seed = legacyStore.openBoard(join(replicaDirectory, 'engine-7-seed.sqlite'), { now: () => new Date(legacyClock) });
  let legacyId;
  let snapshot;
  try {
    legacyStore.register(seed, { lane: 'coordinator', path: '/legacy/coordinator' });
    legacyStore.register(seed, { lane: 'web', path: '/legacy/web' });
    legacyId = legacyStore.addItem(seed, {
      by: 'web-1', lane: 'web', title: 'Legacy claim', route: 'strong', criterion: 'legacy criterion',
      brief: e2e.LIGHT_BRIEF,
    });
    snapshot = legacyExchange.exportBoard(seed);
    assert.ok(snapshot.tables.event.filter(event => event.event_kind === 'join')
      .every(event => JSON.parse(event.event_detail).grantEngine === undefined), 'the old writer emits no future grant marker');
  } finally { legacyStore.closeBoard(seed); }
  const legacy = openBoardWithClock('legacy', legacyClock);
  importBoard(legacy, snapshot);
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
    agentId: 'coordinator', criterion: 'corrected by an ordered coordinator move', reason: 'the fixture corrects its bar',
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
