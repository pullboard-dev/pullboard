import { setItem } from './item-fields.js';
import { liftConditionalHold } from './conditional-holds.js';
import { requireHandoffActive } from './handoff-state.js';
/** Append native events and their rebuildable proof projection in the same transaction [R2]. */
import { ENGINE_VERSION } from './machine.js';
import { writeSync } from 'node:fs';
import { agentModel } from './seats.js';
import { appendProofCounter } from './proof-counters.js';
import { ensureProofCounters } from './proof-counters.js';

import { boardWriteBusyError } from './board-busy.js';
import { beginCapture } from './board-capture.js';
import {
  beginBoardWrite,
  finishBoardWrite,
  prepareBoardWriteIdentity,
} from './board-write-lock.js';

const TRANSACTION_DEPTH = new WeakMap();

/**
 * Run `work` in one immediate transaction: the write lock is taken before the first read, so two
 * agents can never both see an item as free (B2). Nested moves use savepoints so a replay receipt
 * and its board mutation can commit together, while a refused move rolls back only its work.
 *
 * @template T
 * @param {any} board
 * @param {() => T} work
 * @returns {T}
 */
export function atomic(board, work) {
  const depth = TRANSACTION_DEPTH.get(board) ?? 0;
  const savepoint = `pullboard_atomic_${depth}`;
  if (!depth) prepareBoardWriteIdentity();
  const startedAt = Date.now();
  try { board.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'); }
  catch (error) { throw boardWriteBusyError(board.db, startedAt, error); }
  TRANSACTION_DEPTH.set(board, depth + 1);
  const writeRecord = depth ? null : beginBoardWrite(board.db, board.writeContext);
  // A local-first move records the rows it changed, so the relay's order can take it back later (#1013).
  let capture;
  let released = false;
  let outcome = 'release-failed';
  const lastEvent = board.lastEvent;
  const emitted = board.emittedEvents?.length ?? 0;
  try {
    capture = depth ? null : beginCapture(board.db);
    const result = work();
    capture?.prepare();
    board.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
    released = true;
    outcome = 'committed';
    capture?.commit();
    return result;
  } catch (error) {
    if (!released) {
      board.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      released = true;
      outcome = 'rolled-back';
      board.lastEvent = lastEvent;
      board.emittedEvents?.splice(emitted);
    }
    throw error;
  } finally {
    try { capture?.close(); }
    catch {
      // Cleanup must never discard a committed move's replication intent or replace its original failure.
      try { writeSync(2, 'pullboard: capture session cleanup failed; original transaction outcome retained\n'); }
      catch { /* A closed diagnostic stream cannot change the committed result or original refusal. */ }
    }
    finally {
      TRANSACTION_DEPTH.set(board, depth);
      finishBoardWrite(writeRecord, released, outcome);
    }
  }
}

/**
 * Append one move to the event log (R2), retaining its exact row for an API response (A2).
 * Exported for the board's own split modules, such as milestones.js, which record moves the same way.
 *
 * @param {any} board
 * @param {string} by
 * @param {string} kind
 * @param {number | null} itemId
 * @param {object} [detail]
 * @param {Date} [at] An enabled move may share one instant with its deadline.
 */
export function logEvent(board, by, kind, itemId, detail = {}, at) {
  // Standalone native writers take the same actual lock; nested moves retain their existing savepoints.
  if (!(TRANSACTION_DEPTH.get(board) ?? 0)) return atomic(board, () => logEvent(board, by, kind, itemId, detail, at));
  // A refused authenticated request remains auditable; it is not an outgoing board move.
  if (kind !== 'relay_refused') requireHandoffActive(board, by, kind, [{ item: kind === 'shout' ? detail.item : undefined }]);
  board.db.exec('SAVEPOINT proof_event_append');
  try {
    ensureProofCounters(board);
    const model = agentModel(board, by);
    const isAgent = Boolean(board.db.prepare('SELECT 1 FROM agent WHERE agent_id = ?').get(by));
    const recorded = { ...detail, ...((board.executionEngineVersion ?? ENGINE_VERSION) >= 8 && isAgent ? { model: model ?? 'unknown' } : {}),
      ...(board.movePerson ? { person: board.movePerson } : {}) }; // The person behind a relayed move, from engine 73 (engine.js) [E3].
    const inserted = board.db
      .prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)')
      .run(at ? at.toISOString() : board.clock.now().toISOString(), by, kind, itemId, JSON.stringify(recorded));
    const event = board.db.prepare('SELECT * FROM event WHERE event_id = ?').get(inserted.lastInsertRowid);
    appendProofCounter(board, event);
    board.lastEvent = event;
    (board.emittedEvents ??= []).push(event);
    liftConditionalHold(board, event, logEvent, setItem);
    board.db.exec('RELEASE proof_event_append');
  } catch (error) {
    board.db.exec('ROLLBACK TO proof_event_append; RELEASE proof_event_append');
    throw error;
  }
}

