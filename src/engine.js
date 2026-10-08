/** Versioned, deterministic replay through the CLI's existing board engine [H3,H16]. */
import { randomUUID } from 'node:crypto';
import * as store from './board.js';
import { refusalDocument } from './json.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';
import { relayMoveActor, relaySenderProblem } from './relay-sender.js';

/** Only these public board operations may be requested by an encrypted move. */
export const ENGINE_OPERATIONS = Object.freeze([
  'register', 'ensureCoordinator', 'addItem', 'editItem', 'escalate', 'recordAttempt',
  'claim', 'release', 'submit', 'reserveReview', 'reserveNextReview', 'verify', 'merged',
  'withdraw', 'refreeze', 'shout', 'passDecision', 'answerDecision', 'holdLane', 'releaseLane',
  'addMilestone', 'editMilestoneItems', 'moveMilestone', 'editMilestone', 'removeMilestone',
  'recordRowDecisions', 'applyRowDecisions',
]);

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
  if (!Number.isSafeInteger(sequence) || sequence < appliedSequence(board)) throw new Refused('RELAY_CURSOR', 'a checkpoint cannot move replay backwards; fetch the current relay snapshot');
  store.atomic(board, () => {
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
  });
}

/** Start an explicitly relinked remote epoch while keeping all local board rows and history. */
export function startRelayEpoch(board) {
  store.atomic(board, () => {
    board.db.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").run();
    board.db.prepare("DELETE FROM board_meta WHERE meta_key LIKE 'relay_refusal_%'").run();
    metadata(board, 'relay_applied_sequence', '0');
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
  });
}

/** Turn caller-only callbacks into deterministic values before sealing an executable operation. */
export function prepareEngineMove(board, operation, args, { id = randomUUID() } = {}) {
  if (!ENGINE_OPERATIONS.includes(operation) || !Array.isArray(args)) throw new Refused('RELAY_MOVE', 'use a supported board-engine operation with its argument array');
  const values = args.map((value) => value && typeof value === 'object' ? { ...value } : value);
  if (['claim', 'refreeze'].includes(operation)) {
    const options = values[1];
    const item = store.getItem(board, values[0]);
    if (typeof options?.freeze === 'function') {
      let frozen;
      let error;
      try { frozen = options.freeze(item); }
      catch (cause) {
        if (!(cause instanceof Refused)) throw cause;
        error = refusalDocument(cause).error;
      }
      delete options.freeze;
      options.frozen = frozen ?? null;
      options.freezeError = error ?? null;
    }
  }
  const move = { version: 1, engine: ENGINE_VERSION, id, operation, args: values };
  // JSON is the wire format: optional undefined fields become absent on every replica alike.
  return JSON.parse(JSON.stringify(move));
}

/** Validate protocol identity before a future engine or malformed input can alter any replica. */
function validateMove(move) {
  if (!move || move.version !== 1 || !Number.isSafeInteger(move.engine) || move.engine < 1) throw new Refused('RELAY_MOVE', 'this executable move format is invalid; upgrade pullboard or restore a consistent relay snapshot');
  if (move.engine > ENGINE_VERSION) throw new Refused('ENGINE_VERSION', `move engine version ${move.engine} is newer than this pullboard engine version ${ENGINE_VERSION}; upgrade pullboard before applying the relay order`);
  if (typeof move.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(move.id) || !ENGINE_OPERATIONS.includes(move.operation) || !Array.isArray(move.args)) throw new Refused('RELAY_MOVE', 'this sealed operation is invalid; use a supported board-engine operation');
}

/** Restore only the frozen criterion callback; no receiver runs another machine's Git or shell. */
function executableArgs(move) {
  const args = structuredClone(move.args);
  if (['claim', 'refreeze'].includes(move.operation)) {
    const options = args[1];
    if (!options || !Object.hasOwn(options, 'frozen')) throw new Refused('RELAY_MOVE', 'the claim has no frozen criterion; send it with the current pullboard engine');
    options.freeze = () => {
      if (options.freezeError) throw new Refused(options.freezeError.code, options.freezeError.message);
      if (!options.frozen || typeof options.frozen.text !== 'string' || typeof options.frozen.digest !== 'string') throw new Refused('RELAY_MOVE', 'the frozen criterion is invalid; send it with the current pullboard engine');
      return options.frozen;
    };
  }
  return args;
}

/** Read the durable outcome used to recover an acknowledged move after a process interruption. */
export function engineReceipt(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_receipt_' + id);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Authorize each public relay position before replay, retaining refusals atomically with its cursor. */
export function applyRelayMove(board, move, { sequence, at, sender, kind }) {
  const problem = relaySenderProblem(move, sender, kind);
  if (!problem) return applyEngineMove(board, move, { sequence, at });
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(Date.parse(at))) throw new Refused('RELAY_MOVE', 'supply a valid relay sequence and receipt timestamp');
  return store.atomic(board, () => {
    const cursor = appliedSequence(board);
    const key = 'relay_refusal_' + sequence;
    const encoded = JSON.stringify({ move, sender, kind });
    const saved = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    if (sequence <= cursor) {
      const receipt = saved && JSON.parse(saved.meta_value);
      if (!receipt || receipt.record !== encoded) throw new Refused('RELAY_CURSOR', 'this earlier refused position has no matching receipt; fetch a consistent relay snapshot');
      return receipt.outcome;
    }
    if (sequence !== cursor + 1) throw new Refused('RELAY_ORDER', `relay sequence ${sequence} does not follow applied sequence ${cursor}; fetch and apply the missing prefix first`);
    const outcome = { error: refusalDocument(problem).error };
    const clock = board.clock;
    board.clock = { now: () => new Date(at) };
    try {
      store.recordRelayRefusal(board, {
        by: sender?.kind === 'agent' && typeof sender.agent === 'string' ? sender.agent : 'relay',
        sequence, kind, operation: typeof move?.operation === 'string' ? move.operation : null,
        actor: typeof relayMoveActor(move) === 'string' ? relayMoveActor(move) : null, code: problem.code,
      });
    } finally { board.clock = clock; }
    metadata(board, key, JSON.stringify({ record: encoded, outcome }));
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
    return outcome;
  });
}

/**
 * Apply one relay position with the same board functions as the CLI, preserving its refusal.
 * A receipt and prefix commit atomically; duplicate ids return that receipt without another move.
 */
export function applyEngineMove(board, move, { sequence, at }) {
  validateMove(move);
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
      const clock = board.clock;
      board.clock = { now: () => new Date(at) };
      const firstEvent = board.emittedEvents?.length ?? 0;
      try {
        const result = store.atomic(board, () => store[move.operation](board, ...executableArgs(move)));
        outcome = { result: result ?? null, events: (board.emittedEvents?.slice(firstEvent) ?? []).map((event) => ({ ...event })) };
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        outcome = { error: refusalDocument(error).error };
      } finally { board.clock = clock; }
      metadata(board, 'relay_receipt_' + move.id, JSON.stringify({ sequence, move: encoded, outcome }));
    }
    metadata(board, 'relay_applied_sequence', String(sequence));
    metadata(board, 'relay_engine_version', String(ENGINE_VERSION));
    return outcome;
  });
}
