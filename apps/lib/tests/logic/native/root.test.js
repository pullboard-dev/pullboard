import { conditionalHoldFloor } from '../../../../../packages/health/index.js';
import { recordFamilyDeclareActivation } from '../../../../../packages/items/index.js';
import { withDerivedFamily } from '../../../../../packages/items/index.js';
import {
  mainPolicy,
  policyAt,
} from '../../../../../packages/sandbox/index.js';
import { frozenCheck } from '../../../../../packages/sandbox/index.js';
import { itemPolicy } from '../../../../../packages/sandbox/index.js';
import { requireTrunkMerge } from '../../../../../packages/sandbox/index.js';
import { PIPELINE_CAUSE_ENGINE } from '../../../../../packages/state/light.js';
import { firstRefusalDetail } from '../../../../../packages/items/index.js';
import { itemPatchDigest } from '../../../../../packages/items/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { SUBMIT_HANDOFF_ENGINE } from '../../../../../packages/state/light.js';
import { MOVE_REGISTRY } from '../../../../../packages/moves/index.js';
import { MOVE_OPERATIONS } from '../../../../../packages/moves/index.js';
import { minimumMoveEngine } from '../../../../../packages/moves/index.js';
import { declaredMoveActor } from '../../../../../packages/moves/index.js';
import {
  relayPresentation,
  relaySnapshot,
  relayPresentationShout,
} from '../../../../../packages/pages/index.js';
import { verifiedPasskeyRowDecision as presentation_verifiedPasskeyRowDecision } from '../../../../../packages/person/index.js';
import { pendingFit as presentation_pendingFit } from '../../../../../packages/blueprints/index.js';
import { projectFit as presentation_projectFit } from '../../../../../packages/blueprints/index.js';
import { projectState as presentation_projectState } from '../../../../view/index.js';
import { personRequestStatuses as presentation_personRequestStatuses } from '../../../../../packages/link/index.js';
import { personSigningPresentation as presentation_personSigningPresentation } from '../../../../../packages/person/index.js';
import { activeViewAgents as presentation_activeViewAgents } from '../../../../view/index.js';
import { viewProofSummary as presentation_viewProofSummary } from '../../../../view/index.js';
import { fitFile as presentation_fitFile } from '../../../../../packages/blueprints/index.js';
import { boardEnginePorts } from '../../../../../packages/store/index.js';
import { validPresence } from '../../../../../packages/person/index.js';
import { recordTrainLanding } from '../../../../../packages/landing/index.js';
/** Native construction binds all capabilities before guards and preserves the public board API [C7,B1,B2]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as native from '../../../index.js';
import * as door from '../../../../../packages/store/index.js';
import { board as library } from '../../../index.js';
import { fixtureBoard } from '../../../../cli/tests/fixtures/board.js';
import { openBoardStore } from '../../../../../packages/store/index.js';
import { recordRowDraft } from '../../../../../packages/spec/index.js';
import { setPersonSigning } from '../../../../../packages/person/index.js';
import { recordGateRun } from '../../../../../packages/flakes/index.js';
import { advanceItemSource } from '../../../../../packages/sandbox/index.js';

/** The 196 store names the library's public board has always exposed; the door now exports many more [C7,B1,B2]. */
const STORE_NAMES = [
  'ACCEPT_REASON', 'BOARD_BUSY_TIMEOUT_MS', 'EVENT_LOG_VERSION', 'EVIDENCE_KINDS', 'FACT_KINDS', 'PERSON', 'REJECT_REASONS', 'ROUTES',
  'SCHEMA_VERSION', 'SIGNED_EVENT_LOG_VERSION', 'acceptCheck', 'acceptedVerdict', 'actOnActivity', 'activityDeliveryState', 'addBlock', 'addItem',
  'agentActivity', 'agentAt', 'agentById', 'agentCreator', 'allShouts', 'answerDecision', 'answerTypedRequests', 'appendFact', 'applyRehomeItem',
  'applyRowDecisions', 'approveOutside', 'atomic', 'attachItemPatch', 'boardBusyError', 'boardId', 'buildOrder', 'canTake', 'canonicalFamily',
  'canonicalMilestoneTarget', 'checkedLandingCommit', 'claim', 'claimBlock', 'clearReservation', 'closeBoard', 'completeCheckBaseline', 'completeSubmitHandoff', 'coordinatorCheck',
  'coordinatorHolder', 'coordinatorOnly', 'createItemSlice', 'decisionAndEvidenceShouts', 'decisionAnswers', 'declareJob', 'editItem',
  'ensureCoordinator', 'escalate', 'events', 'eventsOfKinds', 'factReference', 'fileTypedRequest', 'finishLandingBatch', 'followItemPatches',
  'foreignBlockers', 'foreignDependencyStates', 'getItem', 'getShout', 'holdItem', 'holdLane', 'inbox', 'intakeOutside', 'itemById',
  'itemCheckAuthor', 'itemFiles', 'itemHold', 'itemPatchDigest', 'itemPatches', 'itemRedirect', 'itemThread', 'itemsInStatus', 'landingBatches',
  'landingFlakes', 'landingLeaseMove', 'landingLeaseState', 'landingTestDefects', 'landingWaiverCovers', 'landingWaiverKind', 'laneHold',
  'laneHolds', 'laneLeads', 'lastMoves', 'lineSettings', 'linkPublishRepair', 'listAgents', 'listItems', 'logEvent', 'maintainStaleState', 'merged',
  'milestonePriorities', 'milestones', 'moveItem', 'nextFor', 'nextSeatId', 'onlyCoordinator', 'openBoardReadOnly', 'openDecisions', 'openHandoff',
  'openRequests', 'passDecision', 'peekShouts', 'pendingRefreeze', 'pendingRefreezeProblem', 'planCompanion', 'postRigorNotices', 'prepareClaim',
  'prepareMergeOnlySubmit', 'prepareQueueSubmitHandoff', 'projectItemThreads', 'proofReceipts', 'queueSubmitHandoff', 'readBoardMembers',
  'readBoardSnapshot', 'readEventLogVersion', 'recentEvents', 'recentShouts', 'recordActivityDelivery', 'recordAttempt', 'recordCoordinatorUsage', 'recordExitProgress',
  'recordHealthFindings', 'recordJobRun', 'recordLandingBatch', 'recordLandingFlake', 'recordLandingTestDefect', 'recordLandingWaiver',
  'recordNextIdle', 'recordProofRun', 'recordRelayRefusal', 'recordRowDecisions', 'recordSharedUsage', 'recordSpecApprovalBaseline', 'recordUsage',
  'recordUsageBatch', 'refreeze', 'register', 'rehomeDestinationItemId', 'rehomeImport', 'rehomeItem', 'relatedItems', 'release', 'releaseItemHold',
  'releaseLane', 'removeItemPatch', 'reopen', 'requestCompanion', 'requireExitActive', 'reserveItem', 'reserveNextReview', 'reserveRehomeItemId', 'reserveReview',
  'reviewHolder', 'reviewOffer', 'reviewQueue', 'reviewQueueBreakdown', 'reviewReleaseCooldown', 'reviewReleaseNoteProblem', 'reviewerChecks',
  'rowDecisions', 'rowDrafts', 'rowVerifications', 'schemaMissing', 'seatEnrolled', 'seatFamily', 'seatLineage', 'setBarReady', 'setBoardMembers',
  'setItem', 'setLaneLead', 'setLineSetting', 'shout', 'shoutDetails', 'signBar', 'specApprovalBaseline', 'specApprovalBaselineExists',
  'startSubmitHandoff', 'stats', 'submit', 'submitInvariantEvents', 'systemClock', 'takeCoordinator', 'takeHandoff', 'typedRequests', 'unreadCount',
  'unverifiedSubmissions', 'validateItemAddition', 'validateItemEdit', 'verdictReviewProblem', 'verdictsFor', 'verify', 'withVerifierStanding',
  'withdraw', 'writeRefused',
];
/** The library names the store's write variants, which the door exports under a board_ prefix [C7,B1,B2]. */
const WRITE_VARIANTS = { ensureCoordinator: 'board_ensureCoordinator', recordNextIdle: 'board_recordNextIdle' };
/** The store surface the library keeps: the explicit names, read from the door. */
const legacy = Object.fromEntries(STORE_NAMES.map(name => [name, door[WRITE_VARIANTS[name] ?? name]]));

test('lib.logic-native-root.native-spec-operations-retain-their-public: native spec operations retain their public identity and explicit draft providers fail before mutation [C7,S1,D1]', t => {
  for (const name of ['draftSpecRow', 'decideSpecRevisions', 'recordRowVerification']) {
    assert.equal(library[name], native[name], 'the public board API names the one native operation definition');
    assert.equal(door[name], undefined, 'the store no longer re-exports the native operation');
  }
  const board = fixtureBoard(t);
  const agentId = legacy.register(board, { lane: 'core', path: '/fixture/spec-port-author' });
  const options = { agentId, row: { id: 'G1', text: 'Keep the exact native draft.', gate: 'review', tier: 'must', section: 'G' } };
  const before = legacy.events(board);
  const refusal = new Error('owned fixture draft provider refused');
  let reads = 0;
  const ports = { ...board.nativePorts,
    /** Refuse the supplied read at the real atomic boundary; no hidden default may replace it. */
    rowDrafts() { reads++; throw refusal; },
  };
  assert.throws(() => recordRowDraft(board, options, ports), error => error === refusal);
  assert.equal(reads, 1);
  assert.deepEqual(legacy.events(board), before, 'a refused provider appends no native event');
  assert.deepEqual(legacy.rowDrafts(board), [], 'a refused provider reserves no row identity');
  const draft = native.draftSpecRow(board, options);
  assert.equal(draft.id, 'G1');
  assert.equal(draft.text, options.row.text);
  assert.equal(draft.by, agentId);
  assert.equal(legacy.events(board).at(-1).event_kind, 'row_draft');
  const after = legacy.events(board);
  assert.deepEqual(native.draftSpecRow(board, options), draft, 'the native wrapper keeps the existing exact-draft idempotency');
  assert.deepEqual(legacy.events(board), after, 'an unchanged native draft records no second event');
});

/** Wrap actual providers so migration observes per-connection bindings before its first callback. */
function observedPorts(label, calls) {
  const original = native.nativeBoardPorts();
  /** Retain the actual transaction while observing the initial connection's capabilities. */
  function atomic(board, work) {
    assert.equal(board.nativePorts.atomic, atomic);
    assert.equal(board.enginePorts, original.enginePorts);
    calls.push(label + ':atomic');
    return original.nativePorts.atomic(board, work);
  }
  /** Retain the native writer and its signed append-only event behavior. */
  function logEvent(...args) {
    calls.push(label + ':event');
    return original.logEvent(...args);
  }
  const nativePorts = { ...original.nativePorts, atomic, logEvent };
  const verification = { ...original.verification,
    /** Observe actual Rigor warming through this connection's explicit capability. */
    ensureRigorCounters(board, ...args) {
      assert.equal(board.runtimePorts.verification, verification);
      assert.ok(Object.isFrozen(verification));
      calls.push(label + ':rigor-warm');
      return original.verification.ensureRigorCounters(board, ...args);
    },
    /** Observe actual event projection without changing the provider's arguments. */
    appendRigorCounter(board, ...args) {
      assert.equal(board.runtimePorts.verification, verification);
      calls.push(label + ':rigor-append');
      return original.verification.appendRigorCounter(board, ...args);
    },
  };
  return {
    ...original, nativePorts, logEvent, verification,
    guards: { ...original.guards,
      /** Migration guards must see the final native and engine bags before returning the connection. */
      guardStore(board) {
        assert.equal(board.nativePorts, nativePorts);
        calls.push(label + ':guards');
        return original.guards.guardStore(board);
      },
    },
    lifecycle: { ...original.lifecycle, atomic,
      /** Proof warming runs on the same connection-local providers as every migration callback. */
      ensureProofCounters(board) {
        assert.equal(board.nativePorts, nativePorts);
        calls.push(label + ':proof');
        return original.lifecycle.ensureProofCounters(board);
      },
    },
  };
}

test('lib.logic-native-root.the-single-native-root-supplies-every: the single native root supplies every port before migration and keeps legacy/library/fixture entry points [C7,B1,B2]', t => {
  assert.equal(door.openBoard, undefined, 'the store no longer re-exports the native root');
  assert.equal(library.openBoard, native.openBoard);
  for (const [name, value] of Object.entries(legacy)) assert.equal(library[name], value, `the library surface keeps the store export ${name}`);
  const calls = [], ports = observedPorts('one', calls);
  const board = native.openBoard(':memory:', undefined, { ports });
  t.after(() => native.closeBoard(board));
  assert.equal(board.runtimePorts, ports);
  for (const name of ['guards', 'operations', 'logEvent', 'query', 'auth']) assert.ok(board.runtimePorts[name], name);
  assert.equal(board.nativePorts, ports.nativePorts);
  assert.equal(board.enginePorts, ports.enginePorts);
  assert.ok(Object.isFrozen(board.nativePorts));
  assert.ok(Object.isFrozen(board.enginePorts));
  assert.ok(calls.includes('one:guards'));
  assert.ok(calls.includes('one:proof'));
  assert.ok(calls.includes('one:rigor-warm'));
  native.board.register(board, { lane: 'coordinator', path: '/private/native-root-test' });
  ports.nativePorts.atomic(board, () => ports.nativePorts.logEvent(board, 'coordinator', 'native-root-proof', null, { exact: true }));
  const event = board.db.prepare("SELECT * FROM event WHERE event_kind='native-root-proof'").get();
  assert.deepEqual(JSON.parse(event.event_detail), { exact: true, model: 'unknown' });
  assert.ok(calls.includes('one:event'));
  assert.ok(calls.includes('one:rigor-append'));
  const fixture = fixtureBoard(t);
  assert.ok(fixture.nativePorts);
  assert.equal(fixture.enginePorts.store.openBoard, native.openBoard);
});

test('lib.logic-native-root.two-native-connections-retain-isolated-providers: two native connections retain isolated providers and clocks without registration side effects [C7,B1]', t => {
  const calls = [];
  const first = native.openBoard(':memory:', { now: () => new Date('2026-01-01T00:00:00Z') }, { ports: observedPorts('a', calls) });
  const second = native.openBoard(':memory:', { now: () => new Date('2026-02-01T00:00:00Z') }, { ports: observedPorts('b', calls) });
  t.after(() => { native.closeBoard(first); native.closeBoard(second); });
  const before = calls.length;
  first.nativePorts.atomic(first, () => {});
  assert.deepEqual(calls.slice(before), ['a:atomic']);
  assert.equal(first.nativePorts.now(first), '2026-01-01T00:00:00.000Z');
  assert.equal(second.nativePorts.now(second), '2026-02-01T00:00:00.000Z');
  assert.notEqual(first.nativePorts, second.nativePorts);
});

test('lib.logic-native-root.raw-storage-refuses-absent-providers-before: raw storage refuses absent providers before filesystem effects and closes a failed migration [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-native-root-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const clock = { now: () => new Date() };
  assert.throws(() => openBoardStore(file, clock), /explicit runtime ports/u);
  assert.equal(existsSync(join(directory, 'never-created')), false);
  const ports = native.nativeBoardPorts();
  // @pullboard-board-file persistence: missing auth must refuse before creating the database directory.
  assert.throws(() => native.openBoard(file, clock, { ports: { ...ports, auth: {} } }), /auth.boardNotWritable/u);
  assert.equal(existsSync(join(directory, 'never-created')), false);
  let captured, reported = 0;
  const failure = new Error('NATIVE_MIGRATION_SENTINEL');
  /** Capture the actual connection so failed migration cleanup can be observed. */
  const atomic = (board, work) => { captured = board; return ports.nativePorts.atomic(board, work); };
  const broken = { ...ports,
    nativePorts: { ...ports.nativePorts, atomic },
    lifecycle: { ...ports.lifecycle, atomic },
    query: { ...ports.query, migrate() { throw failure; } },
    auth: { ...ports.auth, boardNotWritable(file, error) { reported++; return ports.auth.boardNotWritable(file, error); } },
  };
  assert.throws(() => native.openBoard(':memory:', clock, { ports: broken }), error => error === failure);
  assert.equal(reported, 1);
  assert.throws(() => captured.db.prepare('SELECT 1'), /closed|not open/u);
});


test('lib.logic-native-root.incomplete-engine-capabilities-refuse-before-storage: incomplete engine capabilities refuse before storage exists [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-engine-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  for (const key of ['store', 'registry', 'sealSourceAdvance', 'submitHandoffEngines', 'pipelineCauseEngines', 'firstRefusalDetail', 'itemPatchDigest', 'recordFamilyDeclareActivation', 'withDerivedFamily']) {
    const enginePorts = { ...ports.enginePorts };
    delete enginePorts[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: incomplete engine capabilities must refuse before storage exists.
      const board = native.openBoard(file, undefined, { ports: { ...ports, enginePorts } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`enginePorts.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

test('lib.logic-native-root.missing-native-person-identity-refuses-before: missing native person identity refuses before storage exists [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-person-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  const nativePorts = { ...ports.nativePorts };
  delete nativePorts.PERSON;
  assert.throws(() => {
    // @pullboard-board-file persistence: absent native identity must refuse before storage exists.
    const board = native.openBoard(file, undefined, { ports: { ...ports, nativePorts } });
    native.closeBoard(board);
  }, error => error.code === 'NO_POLICY' && error.message.includes('nativePorts.PERSON'));
  assert.equal(existsSync(join(directory, 'never-created')), false);
});

test('lib.logic-native-root.native-read-wrappers-carry-explicit-capabilities: native read wrappers carry explicit capabilities while SQLite remains read-only and schema-preserving [C7,A5,A6]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-native-read-'));
  const file = join(directory, 'board.sqlite');
  let read;
  t.after(() => { try { if (read) native.closeBoard(read); } finally { rmSync(directory, { recursive: true, force: true }); } });
  // @pullboard-board-file persistence: read-only reopening must preserve the actual SQLite schema and deny writes.
  const written = native.openBoard(file);
  native.closeBoard(written);
  const ports = native.nativeBoardPorts();
  read = native.openBoardForRead(file, undefined, { ports });
  assert.equal(read.readOnly, true);
  assert.equal(read.nativePorts, ports.nativePorts);
  assert.equal(read.enginePorts, ports.enginePorts);
  assert.deepEqual(read.nativePorts.rowDrafts(read), []);
  assert.throws(() => read.db.exec('CREATE TABLE forbidden (id INTEGER)'), /readonly|read.only/u);
  assert.equal(read.db.prepare("SELECT name FROM sqlite_master WHERE name='forbidden'").get(), undefined);
  assert.equal(native.openBoardForRead(join(directory, 'absent.sqlite')), null);
  assert.equal(library.openBoardForRead, native.openBoardForRead);
  assert.notEqual(door.openBoardForRead, native.openBoardForRead, 'the store door keeps its own read opener; it never re-exports the native one');
});


test('lib.logic-native-root.source-advance-receipt-capabilities-are-frozen: source advance receipt capabilities are frozen and refuse missing members before storage exists [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-source-receipts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  assert.equal(Object.isFrozen(ports.sourceAdvanceReceipts), true);
  for (const key of ['boardReceiptStore', 'readGateReceipt', 'receiptBody', 'receiptFields', 'guardLandingWrite']) {

    const sourceAdvanceReceipts = { ...ports.sourceAdvanceReceipts };
    delete sourceAdvanceReceipts[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: absent receipt authority refuses before SQLite or its directory exists.
      const board = native.openBoard(file, undefined, { ports: { ...ports, sourceAdvanceReceipts } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`sourceAdvanceReceipts.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

test('lib.logic-native-root.every-verification-capability-is-required-before: every verification capability is required before storage exists [C7,B1,B2]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-verification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  for (const key of Object.keys(ports.verification)) {
    const verification = { ...ports.verification };
    delete verification[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: absent verification capabilities refuse before creating storage.
      const board = native.openBoard(file, undefined, { ports: { ...ports, verification } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`verification.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

/** Native origin and restore capabilities must exist before the first SQLite side effect. */
test('lib.logic-native-root.store-origin-and-restore-capabilities-refuse: store origin and restore capabilities refuse missing providers before storage exists [C7,H16]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-store-providers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  for (const key of ['sourceAdvanceCASProblem', 'beginCommandPhase', 'exportedMeta', 'guardRestore', 'quarantine']) {
    const nativePorts = { ...ports.nativePorts };
    delete nativePorts[key];
    assert.throws(() => {
      // @pullboard-board-file persistence: missing authority refuses before creating the database or its directory.
      const board = native.openBoard(file, undefined, { ports: { ...ports, nativePorts } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`nativePorts.${key}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

/** A partial provider bag must not silently bypass the submit/accept proof-ID guard. */
test('lib.logic-native-root.missing-quarantine-proof-id-authority-refuses: missing quarantine proof-ID authority refuses before storage exists [C7,H16,V4]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-quarantine-proof-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts(), quarantine = { ...ports.nativePorts.quarantine };
  delete quarantine.validateQuarantineProofIds;
  assert.throws(() => {
    // @pullboard-board-file persistence: missing proof-ID authority refuses before creating storage.
    const board = native.openBoard(file, undefined, { ports: { ...ports,
      nativePorts: { ...ports.nativePorts, quarantine } } });
    native.closeBoard(board);
  }, error => error.code === 'NO_POLICY' && error.message.includes('quarantine.validateQuarantineProofIds'));
  assert.equal(existsSync(join(directory, 'never-created')), false);
});

/** Public compatibility and replay use the same actual operation, including its person-auth refusal. */
/** A deferred port is its provider's named delegate: it loads the provider's package at its first call [C7,#7033]. */
function delegates(port, provider) { return typeof port === 'function' && port.name === provider.name; }

test('lib.logic-native-root.the-native-operation-bag-and-counted: the native operation bag and counted public bridge retain actual authority [C7,H16,B2]', t => {
  const board = fixtureBoard(t);
  for (const [name, operation] of Object.entries({ setPersonSigning, recordGateRun, advanceItemSource, recordTrainLanding })) {
    assert.ok(delegates(board.enginePorts.store[name], operation), name);
    assert.equal(door[name], undefined, 'the store no longer bridges the native operation');
    assert.equal(typeof library[name], 'function', 'the unchanged library namespace retains its public operation');
    assert.equal(library[name], native[name], 'the library name is the native lazy delegate (#5487)');
  }
  assert.equal(Object.isFrozen(board.enginePorts.store), true);
  assert.equal(Object.isFrozen(board.nativePorts.quarantine), true, 'each connection retains immutable native quarantine authority');
  board.enginePorts.store.setPersonSigning(board, { agentId: 'person', signed: true });
  assert.equal(legacy.events(board).at(-1).event_kind, 'person_signing');
  const before = legacy.events(board);
  assert.throws(() => board.enginePorts.store.setPersonSigning(board, { agentId: 'person', signed: false }), { code: 'PERSON_SIGNED' });
  assert.throws(() => library.setPersonSigning(board, { agentId: 'person', signed: false }), { code: 'PERSON_SIGNED' });
  assert.deepEqual(legacy.events(board), before, 'neither operation path bypasses the actual passkey guard');
});

test('lib.logic-native-root.native-engine-composition-keeps-supplied-upper: native engine composition keeps supplied upper operations and refuses missing providers before storage [C7,B1,H16]', t => {
  const board = fixtureBoard(t);
  const original = native.nativeBoardPorts().enginePorts;
  for (const [name, provider] of Object.entries({ mainPolicy, policyAt, frozenCheck, itemPolicy, requireTrunkMerge })) assert.ok(delegates(original.sandboxPolicyReads[name], provider), name);
  assert.ok(Object.isFrozen(original.sandboxPolicyReads));
  assert.equal(original.firstRefusalDetail, firstRefusalDetail);
  assert.equal(original.itemPatchDigest, itemPatchDigest);
  assert.equal(original.recordFamilyDeclareActivation, recordFamilyDeclareActivation);
  assert.equal(original.withDerivedFamily, withDerivedFamily);
  assert.deepEqual(original.submitHandoffEngines(), { current: ENGINE_VERSION, handoff: SUBMIT_HANDOFF_ENGINE });
  assert.deepEqual(original.pipelineCauseEngines(), { current: ENGINE_VERSION, pipeline: PIPELINE_CAUSE_ENGINE });
  assert.ok(delegates(original.store.recordTrainLanding, recordTrainLanding));
  assert.equal(typeof native.recordTrainLanding, 'function', 'the public name is a lazy delegate to the provider (#5487)');
  assert.equal(library.recordTrainLanding, native.recordTrainLanding, 'the existing board public name retains exact native identity');
  const before = legacy.events(board);
  const refusal = new Error('EXPLICIT_TRAIN_PROVIDER');
  let calls = 0;
  /** Observe the exact injected operation without delegating or mutating the board. */
  function trainProvider(actualBoard, request) {
    assert.equal(actualBoard, board);
    assert.deepEqual(request, { agentId: 'coordinator' });
    calls++;
    throw refusal;
  }
  const providers = { ...original.store, ...original, validPresence, recordTrainLanding: trainProvider, MOVE_REGISTRY, MOVE_OPERATIONS, minimumMoveEngine, declaredMoveActor, conditionalHoldFloor };
  const composed = boardEnginePorts(providers);
  const floor = () => 42;
  let floorDispatch = 0;
  /** Observe the exact floor provider and request passed by the store's engine adapter. */
  function minimumProvider(operation, args, actualBoard, at, actualFloor) {
    assert.equal(operation, 'claim');
    assert.deepEqual(args, [17]);
    assert.equal(actualBoard, board);
    assert.equal(at, '2026-10-31T00:00:00.000Z');
    assert.equal(actualFloor, floor);
    floorDispatch++;
    return actualFloor();
  }
  const withFloor = boardEnginePorts({ ...providers, conditionalHoldFloor: floor, minimumMoveEngine: minimumProvider });
  assert.equal(withFloor.minimumOperationEngine('claim', [17], board, '2026-10-31T00:00:00.000Z'), 42);
  assert.equal(floorDispatch, 1, 'the explicit provider dispatches exactly once');

  assert.equal(composed.store.recordTrainLanding, trainProvider);
  assert.equal(composed.sandboxPolicyReads, original.sandboxPolicyReads, 'the root passes exact canonical function identities without a cache or fallback');
  for (const name of ['mainPolicy', 'policyAt', 'frozenCheck', 'itemPolicy', 'requireTrunkMerge']) {
    const missingReads = { ...original.sandboxPolicyReads };
    delete missingReads[name];
    assert.throws(() => boardEnginePorts({ ...providers, sandboxPolicyReads: missingReads }),
      error => error.code === 'NO_POLICY' && error.message.includes(`sandboxPolicyReads.${name}`));
  }
  assert.throws(() => composed.store.recordTrainLanding(board, { agentId: 'coordinator' }), error => error === refusal);
  assert.equal(calls, 1);
  assert.deepEqual(legacy.events(board), before);
  assert.ok(delegates(original.store.recordTrainLanding, recordTrainLanding), 'another connection keeps the native provider');
  for (const name of ['submitHandoffEngines', 'pipelineCauseEngines', 'firstRefusalDetail', 'itemPatchDigest', 'recordFamilyDeclareActivation', 'withDerivedFamily', 'recordTrainLanding', 'validPresence', 'sealItemPatchFollow', 'MOVE_REGISTRY', 'MOVE_OPERATIONS', 'minimumMoveEngine', 'declaredMoveActor', 'conditionalHoldFloor']) {
    const missing = { ...providers };
    delete missing[name];
    assert.throws(() => boardEnginePorts(missing), error => error.code === 'NO_POLICY' && error.message.includes(name));
  }
});

/** All native presentation entrypoints refuse before reading any repository, option clock or board. */
test('lib.logic-native-root.presentation-providers-retain-exact-identities-and: presentation providers retain exact identities and all missing ports refuse before effects [C7,A4]', t => {
  const ports = native.nativeBoardPorts().presentation;
  const expected = { verifiedPasskeyRowDecision: presentation_verifiedPasskeyRowDecision, pendingFit: presentation_pendingFit, projectFit: presentation_projectFit, projectState: presentation_projectState, personRequestStatuses: presentation_personRequestStatuses, personSigningPresentation: presentation_personSigningPresentation, activeViewAgents: presentation_activeViewAgents, viewProofSummary: presentation_viewProofSummary, fitFile: presentation_fitFile };
  for (const [name, provider] of Object.entries(expected)) {
    if (['projectState', 'activeViewAgents', 'viewProofSummary'].includes(name)) assert.equal(typeof ports[name], 'function', 'the view entrypoints lazy-load the view app (#5487)');
    else assert.ok(delegates(ports[name], provider), name);
  }
  assert.equal(Object.isFrozen(ports), true);
  let effects = 0;
  const root = { toString() { effects++; throw new Error('repository discovery reached'); } };
  const options = { get board() { effects++; throw new Error('board getter reached'); } };
  for (const name of Object.keys(expected)) {
    const missing = { ...ports, [name]: undefined };
    for (const invoke of [() => relayPresentation(root, options, missing), () => relaySnapshot(root, options, missing), () => relayPresentationShout(root, 1, missing)]) {
      assert.throws(invoke, error => error.code === 'RELAY_PRESENTATION_PORTS');
      assert.equal(effects, 0);
    }
  }
  for (const invoke of [() => relayPresentation(root, options), () => relaySnapshot(root, options), () => relayPresentationShout(root, 1)]) {
    assert.throws(invoke, error => error.code === 'RELAY_PRESENTATION_PORTS');
    assert.equal(effects, 0);
  }
});

/** Supplied custom runtime ports must not bypass the composition factory's missing-provider guard. */
test('lib.logic-native-root.sandbox-policy-capabilities-refuse-before-any: sandbox policy capabilities refuse before any SQLite path is created [C7,B1]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-missing-sandbox-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'never-created', 'board.sqlite');
  const ports = native.nativeBoardPorts();
  for (const name of ['mainPolicy', 'policyAt', 'frozenCheck', 'itemPolicy', 'requireTrunkMerge']) {
    const sandboxPolicyReads = { ...ports.enginePorts.sandboxPolicyReads };
    delete sandboxPolicyReads[name];
    const enginePorts = { ...ports.enginePorts, sandboxPolicyReads };
    assert.throws(() => {
      // @pullboard-board-file persistence: missing sandbox policy must refuse before storage exists.
      const board = native.openBoard(file, undefined, { ports: { ...ports, enginePorts } });
      native.closeBoard(board);
    }, error => error.code === 'NO_POLICY' && error.message.includes(`sandboxPolicyReads.${name}`));
    assert.equal(existsSync(join(directory, 'never-created')), false);
  }
});

/** The library's public board is the explicit store names plus the 32 native operations, so a wider store door never widens it [C7,B1,B2]. */
test('lib.logic-native-root.the-library-public-board-exposes-exactly: the library public board exposes exactly its explicit name list [C7,B1,B2]', () => {
  const native = [
    'addMilestone', 'advanceItemSource', 'beginSentinelRun', 'decideSentinel', 'decideSpecRevisions', 'draftSpecRow', 'editMilestone',
    'editMilestoneItems', 'finishSentinelRun', 'flakeLedger', 'flakeQuarantines', 'gateRuns', 'landingWaiverFor', 'landingWaivers', 'moveMilestone',
    'openBoard', 'openBoardForRead', 'orderMilestoneItems', 'personProposals', 'personSigning', 'proposePersonMove', 'proposeSentinel',
    'recordFlakeObservation', 'recordGateRun', 'recordPublishFinding', 'recordRowVerification', 'recordTrainLanding', 'removeMilestone', 'roadmap',
    'setPersonSigning', 'shipMilestone', 'waivedLandingProof',
  ];
  assert.deepEqual(Object.keys(library).sort(), [...STORE_NAMES, ...native].sort());
});
