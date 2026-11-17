import { engineNumber } from '../logic/engine/number.js';
import { registrationProblem } from '../logic/engine/move/register.js';
import { recordReviewPolicyActivation } from '../../index.js';
import { agentGrantMinimum } from '../logic/grant.js';
import { requireAgentGrant } from '../logic/grant.js';
import { handoffMoveProblem } from '../../index.js';
import { requireHandoffActive } from '../../index.js';
/** Versioned, deterministic replay through the CLI's existing board engine [H3,H16]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { recordedRefusal } from '../logic/recorded/refusal.js';
import { ENGINE_VERSION } from './machine.js';
import { VERIFIER_STANDING_ENGINE } from './machine.js';
import { Refused } from '../../../kernel/light.js';
import { ENGINE_MOVE_STEPS } from './engine/move/steps.js';
import { behindMessage } from '../logic/engine/behind-message.js';
const EXIT_RULES_ENGINE = engineNumber('EXIT_RULES_ENGINE');
const PEOPLE_ENGINE = engineNumber('PEOPLE_ENGINE');

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

/** Delete every recorded relay receipt and refusal: a new epoch starts with none, and a restored one replaces them. */
function clearRelayRows(board) {
  board.db.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'relay_receipt_%' OR meta_key LIKE 'relay_refusal_%'").run();
}

/**
 * Start an explicitly relinked remote epoch while keeping all local board rows and history. Returns the rows it
 * replaced, for restoreRelayEpoch to put back if the link that epoch belongs to is never written (#7772).
 */
export function startRelayEpoch(board, boardId) {
  const ports = enginePorts(board);
  const store = ports.store;
  let saved;
  store.atomic(board, () => {
    saved = board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key = 'board_id' OR meta_key = 'relay_applied_sequence' OR meta_key = 'relay_engine_version' OR meta_key LIKE 'relay_receipt_%' OR meta_key LIKE 'relay_refusal_%'").all();
    if (boardId !== undefined) {
      if (!/^[0-9a-f]{32}$/u.test(boardId)) throw new Refused('RELAY_STORAGE', 'restore a valid native board identity before starting its relay epoch');
      metadata(board, 'board_id', boardId);
    }
    clearRelayRows(board);
    metadata(board, 'relay_applied_sequence', '0');
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
  });
  return saved;
}

/**
 * Put back the rows startRelayEpoch replaced, in one transaction: the board id, applied sequence, engine version and
 * every receipt and refusal. Why: a relay on that fails after the epoch starts must leave the board id unchanged (#7772).
 */
export function restoreRelayEpoch(board, saved) {
  const store = enginePorts(board).store;
  store.atomic(board, () => {
    clearRelayRows(board);
    for (const row of saved) metadata(board, row.meta_key, row.meta_value);
  });
}

/**
 * The device running the lowest engine below the one a move needs, or null when none is below it.
 * Why a list from the caller: state cannot import link, so the relay roster is read by the caller (setting engine.nameBehindDevice) and passed in [C7,#9418].
 *
 * @param {{ device: string, seat: string, engine: number }[]} devices
 * @param {number} needed
 * @returns {{ device: string, seat: string, engine: number } | null}
 */
function lowestBehind(devices, needed) {
  const behind = (Array.isArray(devices) ? devices : []).filter(entry => Number.isSafeInteger(entry?.engine) && entry.engine < needed && typeof entry.device === 'string' && typeof entry.seat === 'string');
  return behind.reduce((lowest, entry) => (!lowest || entry.engine < lowest.engine ? entry : lowest), null);
}

/** Turn caller-only callbacks into deterministic values before sealing an executable operation. */
export function prepareEngineMove(board, operation, args, { id = randomUUID(), actor, nameBehindDevice = false, behindDevices = [], releases = [] } = {}) {
  const ports = enginePorts(board);
  const store = ports.store;
  if (!ports.operations.includes(operation) || !Array.isArray(args)) throw new Refused('RELAY_MOVE', 'use a supported board-engine operation with its argument array');
  // Each operation's own sealing steps live in its engine-move module [C7].
  const steps = Object.hasOwn(ENGINE_MOVE_STEPS, operation) ? ENGINE_MOVE_STEPS[operation] : {};
  if (steps.prepareArgs) args = steps.prepareArgs(board, args, { ports, store, id });
  const values = args.map((value) => value && typeof value === 'object' ? { ...value } : value);
  steps.validate?.(values);
  steps.prepareBefore?.(board, values, { args, ports, store, id });
  const minimumEngine = Math.max(ports.minimumOperationEngine(operation, values, board), agentGrantMinimum(board, { operation, args: values }));
  if (ENGINE_VERSION < minimumEngine) {
    const behind = nameBehindDevice === true ? lowestBehind(behindDevices, minimumEngine) : null;
    if (behind) throw new Refused('ENGINE_VERSION', behindMessage({ device: behind.device, seat: behind.seat, running: behind.engine, needed: minimumEngine, releases }));
    throw new Refused('ENGINE_VERSION', `${operation} requires engine version ${minimumEngine}; this pullboard uses engine ${ENGINE_VERSION}; upgrade before sending it`);
  }
  steps.prepareAfter?.(board, values, { args, ports, store, id });
  const move = { version: 1, engine: ENGINE_VERSION, id, operation, args: values, ...(actor === undefined ? {} : { actor }) };
  // JSON is the wire format: optional undefined fields become absent on every replica alike.
  return JSON.parse(JSON.stringify(move));
}

/** Stop before interpreting actors or operations that a newer engine may have changed. */
export function requireSupportedEngine(move) {
  if (Number.isSafeInteger(move?.engine) && move.engine > ENGINE_VERSION) throw new Refused('ENGINE_VERSION', `move engine version ${move.engine} is newer than this pullboard engine version ${ENGINE_VERSION}; upgrade pullboard before applying the relay order`);
}

/** Validate protocol identity before a future engine or malformed input can alter any replica. */
function validateMove(move, ports) {
  if (!move || move.version !== 1 || !Number.isSafeInteger(move.engine) || move.engine < 1) throw new Refused('RELAY_MOVE', 'this executable move format is invalid; upgrade pullboard or restore a consistent relay snapshot');
  requireSupportedEngine(move);
  if (typeof move.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(move.id) || !ports.operations.includes(move.operation) || !Array.isArray(move.args)) throw new Refused('RELAY_MOVE', 'this sealed operation is invalid; use a supported board-engine operation');
  const steps = Object.hasOwn(ENGINE_MOVE_STEPS, move.operation) ? ENGINE_MOVE_STEPS[move.operation] : {};
  steps.validate?.(move.args);
  const minimumEngine = ports.minimumOperationEngine(move.operation, move.args, undefined, undefined, { replayEngine: move.engine });
  if (move.engine < minimumEngine) throw new Refused('RELAY_MOVE', `${move.operation} cannot be replayed from engine version ${move.engine}; it was introduced in engine ${minimumEngine}; restore a consistent relay prefix`);
}

/** Restore only the frozen criterion callback; no receiver runs another machine's Git or shell. */
export function executableArgs(move, board) {
  const ports = enginePorts(board);
  const store = ports.store;
  const args = structuredClone(move.args);
  const steps = Object.hasOwn(ENGINE_MOVE_STEPS, move.operation) ? ENGINE_MOVE_STEPS[move.operation] : {};
  steps.replayArgs?.(board, args, { move, store });
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

/** Authorize each public relay position before replay, retaining refusals atomically with its cursor. */
export function applyRelayMove(board, move, { sequence, at, sender, kind, digest = null, registration }) {
  const ports = enginePorts(board);
  const store = ports.store;
  requireSupportedEngine(move);
  const phoneReceipt = sender?.kind === 'machine' && move?.engine >= 6 && Boolean(move.personRequest) && !ports.requestMoveProblem(board, move, { checkExecutorLease: false });
  const problem = ports.relaySenderProblem(move, sender, kind, { phoneReceipt })
    ?? (kind === 'move' ? handoffMoveProblem(board, ports.relayMoveActor(move), move.operation, move.args) : null)
    ?? (kind === 'move' ? registrationProblem(board, move, { sender, registration, sequence, digest }, ports) : null)
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
    const measure = (name, work) => store.measureBoardWritePhase ? store.measureBoardWritePhase(board.db, name, work) : work();
    const cursor = measure('engine-cursor', () => appliedSequence(board));
    const previous = measure('engine-receipt-read', () => engineReceipt(board, move.id));
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
      const minimumEngine = measure('engine-minimum', () => Math.max(ports.minimumOperationEngine(move.operation, move.args, board, new Date(at), { replayEngine: move.engine }), agentGrantMinimum(board, move)));
      if (move.engine < minimumEngine) throw new Refused('RELAY_MOVE', `${move.operation} cannot act on a checked-composition snapshot from engine ${move.engine}; use engine ${minimumEngine} or newer`);
      // Missing immutable objects abort before a refusal receipt or cursor could make a fetch unrecoverable.
      const steps = Object.hasOwn(ENGINE_MOVE_STEPS, move.operation) ? ENGINE_MOVE_STEPS[move.operation] : {};
      if (steps.replayBefore) measure('engine-replay-prepare', () => steps.replayBefore(board, move.args, { ports }));
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
          const problem = measure('engine-request-guard', () => ports.requestMoveProblem(board, move));
          if (problem) throw problem;
          // One main checkout coordinates a linked board at a time; another is refused by name (#347).
          measure('engine-coordinator-guard', () => ports.requireCoordinatorHold(board, move, standing?.lineage, at));
          measure('engine-handoff-guard', () => requireHandoffActive(board, ports.relayMoveActor(move), move.operation, move.args));
          if (move.engine >= EXIT_RULES_ENGINE) measure('engine-exit-guard', () => store.requireExitActive(board, ports.relayMoveActor(move), move.operation, move.args));
          measure('engine-agent-grant', () => requireAgentGrant(board, move));
          return measure('engine-native-move', () => store[move.operation](board, ...executableArgs(move, board)));
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
      ports.recordFamilyDeclareActivation(board, move.engine);
      ports.recordRequestMove(board, move, outcome, sequence, at);
      metadata(board, 'relay_receipt_' + move.id, JSON.stringify({ sequence, move: encoded, outcome }));
    }
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
    return outcome;
  }, { reviewPolicy: false });
}
