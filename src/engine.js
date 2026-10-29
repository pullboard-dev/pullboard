import { recordReviewPolicyActivation } from '../packages/state/index.js';
import { agentGrantMinimum } from './agent-grant.js';
import { recordFamilyDeclareActivation } from './family-declaration.js';
import { requireAgentGrant } from './agent-grant.js';
import { rejectedWorkReturns } from '../packages/state/index.js';
import { handoffMoveProblem } from '../packages/state/index.js';
import { requireHandoffActive } from '../packages/state/index.js';
import { manualLandingFailureQuoted } from '../packages/state/src/core/manual-landing-failure-quoted.js';
import { submissionSize } from '../packages/state/index.js';
import { lineSettings } from '../packages/state/index.js';
/** Versioned, deterministic replay through the CLI's existing board engine [H3,H16]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { COORDINATOR } from './config.js';
import { recordedRefusal } from './recorded-refusal.js';
import { PEOPLE_ENGINE } from './people-engine.js';
import { ENGINE_VERSION } from './machine.js';
import { VERIFIER_STANDING_ENGINE } from './machine.js';
import { canonicalMilestoneTarget } from '../packages/state/index.js';
import { Refused } from './refused.js';
import { SUBMISSION_PROOF_ENGINE } from './move-engine-constants.js';
import { submissionProof } from '../packages/state/index.js';
import { MERGE_ONLY_VERDICT_ENGINE } from './merge-only-verdict-engine.js';

/** Require the explicit runtime ports supplied by the board owner, never a receiver-local loader. */
function enginePorts(board) {
  if (!board.enginePorts) throw new Refused('RELAY_MOVE', 'open this board through its owning store before preparing or replaying moves');
  return board.enginePorts;
}

/** Read a replica's committed prefix without trusting an independently saved transport cursor. */
export function appliedSequence(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_applied_sequence');
  const value = row ? Number(row.meta_value) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Refused('RELAY_CURSOR', 'the local replay cursor is invalid; restore a consistent board snapshot');
  return value;
}

/** Store protocol metadata inside the same transaction as the move it describes. */
function metadata(board, name, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(name, value);
}

/** Advance a checkpoint made from an already-applied legacy mirror, without reexecuting its events. */
export function checkpointSequence(board, sequence) {
  const ports = enginePorts(board);
  const store = ports.store;
  if (!Number.isSafeInteger(sequence) || sequence < appliedSequence(board)) throw new Refused('RELAY_CURSOR', 'a checkpoint cannot move replay backwards; fetch the current relay snapshot');
  store.atomic(board, () => {
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
  });
}

/** Start an explicitly relinked remote epoch while keeping all local board rows and history. */
export function startRelayEpoch(board, boardId) {
  const ports = enginePorts(board);
  const store = ports.store;
  store.atomic(board, () => {
    if (boardId !== undefined) {
      if (!/^[0-9a-f]{32}$/u.test(boardId)) throw new Refused('RELAY_STORAGE', 'restore a valid native board identity before starting its relay epoch');
      metadata(board, 'board_id', boardId);
    }
    board.db.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").run();
    board.db.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'relay_refusal_%'").run();
    metadata(board, 'relay_applied_sequence', '0');
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
  });
}

/** Turn caller-only callbacks into deterministic values before sealing an executable operation. */
export function prepareEngineMove(board, operation, args, { id = randomUUID(), actor } = {}) {
  const ports = enginePorts(board);
  const store = ports.store;
  if (!ports.operations.includes(operation) || !Array.isArray(args)) throw new Refused('RELAY_MOVE', 'use a supported board-engine operation with its argument array');
  if (operation === 'reopen') args = ports.computedReturnArgs(board, args);
  const values = args.map((value) => value && typeof value === 'object' ? { ...value } : value);
  if (operation === 'recordTrainLanding') {
    const request = values[0];
    if (request?.agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator seals a train landing');
    const prepared = request?.nativeBatch
      ? ports.prepareNativeTrainLanding(request?.batch?.root, board, request.nativeBatch, request?.receipt?.id)
      : ports.prepareTrainLanding(request?.batch?.root, board,
        request?.batch?.items?.map(item => item.id), request?.batch?.tip, request?.receipt?.id);
    values[0] = { ...prepared, ...(request?.landingFence === undefined ? {} : { landingFence: request.landingFence }) };
  }
  if (operation === 'rehomeItem' && values[1] && typeof values[1] === 'object') {
    if (values[1].sourceMoveId !== undefined && values[1].sourceMoveId !== id) throw new Refused('RELAY_MOVE', 'a re-home must retain its exact source MOVEID');
    values[1] = { ...values[1], sourceMoveId: id };
  }
  validateSpecRefreezeMarker(operation, values);
  if (operation === 'reopen' && values[1] && typeof values[1] === 'object'
    && manualLandingFailureQuoted(values[1].note)) values[1].quotedLandingFailure = true;
  // Seal native stored facts at origin; replicas replay these bytes without the origin file.
  if (operation === 'reopen' && args[1]?.sourceAdvanceReturn !== undefined) values[1] = ports.sealSourceAdvanceReturn(board, values[0], args[1]);
  if (operation === 'advanceItemSource') values[1] = ports.sealSourceAdvance(board, values[0], args[1]);
  if (operation === 'recordProofRun') {
    const receipt = ports.boundProofReceipt(board, args[0]);
    values[0] = { agentId: args[0].agentId, itemId: args[0].itemId, receipt };
  }
  if (['attachItemPatch', 'removeItemPatch'].includes(operation) && store.getItem(board, values[0]).item_status === 'claimed') {
    values[1] = { ...values[1], presubmit: true };
  }
  if (operation === 'submit') values[1] = ports.sealItemPatchSubmit(board, values[0], values[1]);
  if (operation === 'followItemPatches') values[1] = ports.sealItemPatchFollow(board, values[0], values[1]);
  if (operation === 'submit' && ENGINE_VERSION >= SUBMISSION_PROOF_ENGINE) submissionProof(values[1]?.submissionProof);
  // Derive once before sealing; replicas never re-decide a recorded carry from their local objects.
  if (operation === 'submit' && ENGINE_VERSION >= MERGE_ONLY_VERDICT_ENGINE && values[1]) {
    const carry = store.prepareMergeOnlySubmit(board, values[0], values[1], { getItem: store.getItem, acceptedVerdict: store.acceptedVerdict, identity: board.nativePorts });
    delete values[1].mergeOnly;
    if (carry) values[1].mergeOnly = carry;
  }
  if (operation === 'submit') submissionSize(values[1]?.submissionSize, values[1]?.commit);
  if (operation === 'claim' && ['wipPerReviewer', 'takeoverMinutes'].some(key => typeof lineSettings(board)[key] === 'number')) {
    values[1] = { ...values[1], lineCapacity: true };
  }
  const minimumEngine = Math.max(ports.minimumOperationEngine(operation, values, board), agentGrantMinimum(board, { operation, args: values }));
  if (ENGINE_VERSION < minimumEngine) throw new Refused('ENGINE_VERSION', `${operation} requires engine version ${minimumEngine}; this pullboard uses engine ${ENGINE_VERSION}; upgrade before sending it`);
  // A gate run is sealed only as its gate's own receipt; a run made up by hand is refused before it reaches any replica.
  if (operation === 'recordGateRun') ports.requireBound(board, values[0]?.receipt);
  if (operation === 'reopen' && values[1]?.computedConflict !== undefined) {
    if (values[1].conflict !== undefined) throw new Refused('COORDINATOR_ONLY', 'automatic conflict evidence accepts no caller conflict assertion');
    ports.requirePreparedComputedConflict(board, values[0], values[1].agentId, values[1].computedConflict);
  }
  // Freeze local liveness only at the authenticated sender; receivers replay this observation.
  if (operation === 'recordHealthFindings' && values[0]?.returnRejected === true) {
    if (values[0].agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'ask the coordinator to return unattended rejects');
    rejectedWorkReturns(board, values[0].findings, ports.withSeatPresence);
  }
  if (operation === 'verify' && values[1]?.sandbox !== undefined) ports.requireOutsideReceipt(board, values[1].sandbox);
  if (operation === 'release') {
    const problem = store.reviewReleaseNoteProblem(board, values[0], values[1], values[2]);
    if (problem) throw problem;
  }
  if (['claim', 'refreeze'].includes(operation) || operation === 'editItem' && values[1]?.correction === true) {
    const options = values[1];
    const item = store.getItem(board, values[0]);
    if (typeof options?.freeze === 'function') {
      let frozen;
      let error;
      try { frozen = options.freeze(operation === 'editItem' ? { ...item, ...store.validateItemEdit(board, values[0], options).next } : item); }
      catch (cause) {
        if (!(cause instanceof Refused)) throw cause;
        error = recordedRefusal(cause);
      }
      delete options.freeze;
      options.frozen = frozen ?? null;
      options.freezeError = error ?? null;
    }
  }
  // A target is fixed to one instant here, so replicas in other time zones read the same one.
  if (operation === 'editMilestone' && values[1] && 'target' in values[1]) values[1].target = canonicalMilestoneTarget(values[1].target);
  const move = { version: 1, engine: ENGINE_VERSION, id, operation, args: values, ...(actor === undefined ? {} : { actor }) };
  // JSON is the wire format: optional undefined fields become absent on every replica alike.
  return JSON.parse(JSON.stringify(move));
}

/** Stop before interpreting actors or operations that a newer engine may have changed. */
export function requireSupportedEngine(move) {
  if (Number.isSafeInteger(move?.engine) && move.engine > ENGINE_VERSION) throw new Refused('ENGINE_VERSION', `move engine version ${move.engine} is newer than this pullboard engine version ${ENGINE_VERSION}; upgrade pullboard before applying the relay order`);
}

/** Treat a present correction array, including an empty one, as the new apply protocol marker. */
function validateSpecRefreezeMarker(operation, args) {
  if (operation === 'applyRowDecisions' && Object.hasOwn(args[0] ?? {}, 'refreezes') && !Array.isArray(args[0].refreezes)) {
    throw new Refused('ROW_DECISION', 'the spec correction payload is invalid; run pullboard spec apply again');
  }
}

/** Validate protocol identity before a future engine or malformed input can alter any replica. */
function validateMove(move, ports) {
  if (!move || move.version !== 1 || !Number.isSafeInteger(move.engine) || move.engine < 1) throw new Refused('RELAY_MOVE', 'this executable move format is invalid; upgrade pullboard or restore a consistent relay snapshot');
  requireSupportedEngine(move);
  if (typeof move.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(move.id) || !ports.operations.includes(move.operation) || !Array.isArray(move.args)) throw new Refused('RELAY_MOVE', 'this sealed operation is invalid; use a supported board-engine operation');
  validateSpecRefreezeMarker(move.operation, move.args);
  const minimumEngine = ports.minimumOperationEngine(move.operation, move.args);
  if (move.engine < minimumEngine) throw new Refused('RELAY_MOVE', `${move.operation} cannot be replayed from engine version ${move.engine}; it was introduced in engine ${minimumEngine}; restore a consistent relay prefix`);
}

/** Restore only the frozen criterion callback; no receiver runs another machine's Git or shell. */
export function executableArgs(move, board) {
  const ports = enginePorts(board);
  const store = ports.store;
  const args = structuredClone(move.args);
  if (move.operation === 'rehomeItem' && args[1]?.sourceMoveId !== move.id) throw new Refused('RELAY_MOVE', 'a re-home source MOVEID does not match its sealed move');
  if (move.operation === 'appendFact') {
    if (!args[1] || typeof args[1] !== 'object' || Array.isArray(args[1])) throw new Refused('RELAY_MOVE', 'a fact needs its typed arguments; use the current Pullboard engine');
    args[1].factId = move.id;
  }
  // Implied facts take their ids from the sealed move, so every replica writes the same ones.
  if (['answerDecision', 'verify'].includes(move.operation) && args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) args[1].impliesId = move.id;
  if (['claim', 'refreeze'].includes(move.operation) || move.operation === 'editItem' && args[1]?.correction === true) {
    const options = args[1];
    if (!options || !Object.hasOwn(options, 'frozen')) throw new Refused('RELAY_MOVE', 'the claim has no frozen criterion; send it with the current pullboard engine');
    options.freeze = () => {
      if (options.freezeError) throw new Refused(options.freezeError.code, options.freezeError.message);
      if (!options.frozen || typeof options.frozen.text !== 'string' || typeof options.frozen.digest !== 'string') throw new Refused('RELAY_MOVE', 'the frozen criterion is invalid; send it with the current pullboard engine');
      return options.frozen;
    };
  }
  if (move.operation === 'verify') {
    const item = store.getItem(board, args[0]);
    const options = args[1];
    let frozen;
    try { frozen = JSON.parse(item.item_frozen ?? 'null'); }
    catch { throw new Refused('NO_POLICY', 'the frozen verify policy is invalid; ask the coordinator to refreeze this item before verifying it'); }
    const capturedPolicy = frozen?.policy;
    const captured = capturedPolicy?.verify;
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        capturedPolicy?.version !== 1 || !/^[0-9a-f]{40,64}$/.test(capturedPolicy.commit ?? '') ||
        !['any', 'coordinator'].includes(captured?.policy) || !['off', 'prefer', 'require'].includes(captured?.family)) {
      throw new Refused('NO_POLICY', 'the frozen verify policy is missing or invalid; ask the coordinator to refreeze this item before verifying it');
    }
    args[1] = { ...options, policy: captured.policy, familyPolicy: captured.family, impliesId: move.id };
  }
  return args;
}

/** Read the durable outcome used to recover an acknowledged move after a process interruption. */
export function engineReceipt(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_receipt_' + id);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Record one relay refusal and advance exactly one authenticated transport position atomically. */
export function refuseRelayMove(board, move, { sequence, at, sender, kind, code, digest = null, refusal = null }) {
  const ports = enginePorts(board);
  const store = ports.store;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(Date.parse(at))) throw new Refused('RELAY_ORDER', 'the refused relay position is invalid; fetch the ordered relay prefix');
  const normalizedBy = ports.validRelaySender(sender) && sender.kind === 'agent' ? sender.agent : 'relay';
  const record = digest ?? createHash('sha256').update(JSON.stringify({ move, sender, kind })).digest('hex');
  const key = 'relay_refusal_' + sequence;
  return store.atomic(board, () => {
    const cursor = appliedSequence(board);
    const saved = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    if (sequence <= cursor) {
      const prior = saved && JSON.parse(saved.meta_value);
      if (!prior || prior.record !== record) throw new Refused('RELAY_CURSOR', 'this refused relay position has no matching receipt; fetch a consistent snapshot');
      return prior.outcome;
    }
    if (sequence !== cursor + 1) throw new Refused('RELAY_ORDER', `relay sequence ${sequence} does not follow applied sequence ${cursor}; fetch the missing prefix first`);
    const candidateItemId = ports.registry[move?.operation]?.itemIdFirstArgument ? move?.args?.[0] : null;
    const itemId = Number.isSafeInteger(candidateItemId) && candidateItemId > 0 && board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(candidateItemId) ? candidateItemId : null;
    const reason = refusal ?? new Refused(code, 'this relay record was refused and logged; run pullboard relay to continue with the next ordered record');
    const outcome = { error: recordedRefusal(reason) };
    const clock = board.clock;
    board.clock = { now: () => new Date(at) };
    try {
      store.recordRelayRefusal(board, { by: normalizedBy, sequence, kind, operation: typeof move?.operation === 'string' ? move.operation : null,
        actor: typeof ports.relayMoveActor(move) === 'string' ? ports.relayMoveActor(move) : null, code, itemId, person: ports.requestPerson(board, move) ?? ports.relayPerson(sender) });
    } finally { board.clock = clock; }
    metadata(board, key, JSON.stringify({ record, outcome }));
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
    return outcome;
  });
}

/**
 * Bind an engine-48 registration to the relay's receipt (#579). A seat made by another seat names
 * itself in the move (`id`) and arrives with the receipt the relay issued its first token under:
 * same target, the authenticated creator, this position and these exact sealed bytes. A join no
 * seat made is machine-sent and carries no receipt; a receipt on any other move is refused.
 *
 * @param {any} board
 * @param {any} move
 * @param {{ sender: any, registration?: any, sequence: number, digest: string | null }} record
 * @returns {Refused | null}
 */
function registrationProblem(board, move, { sender, registration, sequence, digest }) {
  const ports = enginePorts(board);
  const store = ports.store;
  const refuse = (why) => new Refused('RELAY_REGISTRATION', `${why}; register the seat again from its creating seat's checkout`);
  const options = move?.operation === 'register' && move.engine >= VERIFIER_STANDING_ENGINE ? move.args?.[0] : null;
  if (!options || sender?.kind === 'person') return registration === undefined || registration === null ? null : refuse('the relay attached a seat receipt to a move that registers no seat');
  const existing = typeof options.path === 'string' ? store.agentAt(board, options.path) : null;
  if (sender.kind === 'machine' || existing) {
    if (registration !== undefined && registration !== null) return refuse('a machine join or a returning seat carries no seat receipt');
    if (existing && sender.kind === 'agent' && existing.agent_id !== sender.agent) return refuse(`agent ${sender.agent} cannot register another seat's worktree`);
    return null;
  }
  if (options.createdBy === COORDINATOR && sender.root !== true) {
    return refuse('only the coordinator credential the person set up creates seats; run pullboard relay on in the main checkout once');
  }
  const receipt = registration ?? {};
  if (typeof options.id !== 'string' || receipt.target !== options.id || receipt.creator !== sender.agent || receipt.creator !== options.createdBy ||
      receipt.sequence !== sequence || typeof digest !== 'string' || receipt.digest !== digest) {
    return refuse('a new seat needs the relay receipt its creator received for exactly this sealed move');
  }
  return null;
}

/** Authorize each public relay position before replay, retaining refusals atomically with its cursor. */
export function applyRelayMove(board, move, { sequence, at, sender, kind, digest = null, registration }) {
  const ports = enginePorts(board);
  const store = ports.store;
  requireSupportedEngine(move);
  const phoneReceipt = sender?.kind === 'machine' && move?.engine >= 6 && Boolean(move.personRequest) && !ports.requestMoveProblem(board, move, { checkExecutorLease: false });
  const problem = ports.relaySenderProblem(move, sender, kind, { phoneReceipt })
    ?? (kind === 'move' ? handoffMoveProblem(board, ports.relayMoveActor(move), move.operation, move.args) : null)
    ?? (kind === 'move' ? registrationProblem(board, move, { sender, registration, sequence, digest }) : null)
    // With signing on, a person-only move counts only when it carries out a passkey-confirmed request [E22].
    ?? (kind === 'move' ? ports.signedMoveProblem(board, ports.personAuthority(move), phoneReceipt ? move.personRequest : null) : null);
  if (!problem) {
    // Engine-48 relay moves run under linked verifier standing; older recorded moves replay as they did.
    // The person is above every seat; their own moves act with the coordinator's standing.
    const standing = move?.engine >= VERIFIER_STANDING_ENGINE ? { root: sender?.root === true || sender?.kind === 'person',
      person: sender?.kind === 'person', lineage: sender?.root === true && typeof sender.lineage === 'string' ? sender.lineage : null } : null;
    // The relay-authenticated GitHub login names the person behind the move, whoever sent it; a move that carries out
    // a phone request is the phone person's, though their computer sent it [E3].
    return applyEngineMove(board, move, { sequence, at, standing, enrollment: registration?.target ?? null,
      person: ports.requestPerson(board, move) ?? (typeof sender?.login === 'string' ? sender.login : null) });
  }
  return refuseRelayMove(board, move, { sequence, at, sender, kind, code: problem.code, digest, refusal: problem });
}

/**
 * Apply one relay position with the same board functions as the CLI, preserving its refusal.
 * A receipt and prefix commit atomically; duplicate ids return that receipt without another move.
 */
export function applyEngineMove(board, move, { sequence, at, standing = null, enrollment = null, person = null }) {
  const ports = enginePorts(board);
  const store = ports.store;
  validateMove(move, ports);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(Date.parse(at))) throw new Refused('RELAY_MOVE', 'supply a valid relay sequence and receipt timestamp');
  return store.atomic(board, () => {
    const cursor = appliedSequence(board);
    const previous = engineReceipt(board, move.id);
    const encoded = JSON.stringify(move);
    if (previous && previous.move !== encoded) throw new Refused('RELAY_MOVE', 'this move id names different contents; restore a consistent relay prefix');
    if (sequence <= cursor) {
      if (!previous) throw new Refused('RELAY_CURSOR', 'this earlier move has no local receipt; fetch a consistent relay snapshot');
      return previous.outcome;
    }
    if (sequence !== cursor + 1) throw new Refused('RELAY_ORDER', `relay sequence ${sequence} does not follow applied sequence ${cursor}; fetch and apply the missing prefix first`);
    let outcome = previous?.outcome;
    if (!outcome) {
      // Existing receipts replay before consulting newer snapshot semantics.
      const minimumEngine = Math.max(ports.minimumOperationEngine(move.operation, move.args, board, new Date(at)), agentGrantMinimum(board, move));
      if (move.engine < minimumEngine) throw new Refused('RELAY_MOVE', `${move.operation} cannot act on a checked-composition snapshot from engine ${move.engine}; use engine ${minimumEngine} or newer`);
      // Missing immutable objects abort before a refusal receipt or cursor could make a fetch unrecoverable.
      if (move.operation === 'reopen' && move.args[1]?.computedConflict !== undefined) ports.preflightComputedConflict(board, move.args[0], move.args[1].agentId, move.args[1].computedConflict);
      const clock = board.clock;
      const engineVersion = board.executionEngineVersion;
      board.clock = { now: () => new Date(at) };
      board.executionEngineVersion = move.engine;
      const firstEvent = board.emittedEvents?.length ?? 0;
      if (enrollment !== null) board.relayEnrollment = enrollment;
      // From engine 73 every event of the move names its person; an older move replays without one.
      if (person !== null && move.engine >= PEOPLE_ENGINE) board.movePerson = person;
      try {
        const execute = () => store.atomic(board, () => {
          const problem = ports.requestMoveProblem(board, move);
          if (problem) throw problem;
          // One main checkout coordinates a linked board at a time; another is refused by name (#347).
          ports.requireCoordinatorHold(board, move, standing?.lineage, at);
          requireHandoffActive(board, ports.relayMoveActor(move), move.operation, move.args);
          requireAgentGrant(board, move);
          return store[move.operation](board, ...executableArgs(move, board));
        });
        const result = standing ? store.withVerifierStanding(board, standing, execute) : execute();
        outcome = { result: result ?? null, events: (board.emittedEvents?.slice(firstEvent) ?? []).map((event) => ({ ...event })) };
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        const refusal = recordedRefusal(error);
        // Engine 8 stored generic merge-refusal guidance before the serializer recognized "merge".
        if (move.engine === 8 && move.operation === 'merged' && error.code === 'NOT_VERIFIED') {
          refusal.next = 'Run pullboard help, correct the reported problem, and retry the command.';
        }
        outcome = { error: refusal };
      } finally {
        board.clock = clock;
        delete board.relayEnrollment;
        delete board.movePerson;
        if (engineVersion === undefined) delete board.executionEngineVersion;
        else board.executionEngineVersion = engineVersion;
      }
      recordReviewPolicyActivation(board, move.engine);
      recordFamilyDeclareActivation(board, move.engine);
      ports.recordRequestMove(board, move, outcome, sequence, at);
      metadata(board, 'relay_receipt_' + move.id, JSON.stringify({ sequence, move: encoded, outcome }));
    }
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
    return outcome;
  });
}
