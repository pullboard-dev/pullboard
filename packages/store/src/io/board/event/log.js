import { setItem as writeItemFields } from "../../../../../items/index.js";
import { now } from "../query.js";
import { liftInfraHold } from "../../../logic/board/release.js";
import { liftTwiceHold } from "../../../logic/board/release.js";
import { liftSettledHolds } from "../../../logic/board/holds.js";
import { liftConditionalHold } from "../../../logic/board/holds.js";
import { requireHandoffActive } from "../../../../../state/light.js";
import { eventKindRefusal } from "../../../../../state/light.js";
/** Append native events and their rebuildable proof projection in the same transaction [R2]. */
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { fileURLToPath } from 'node:url';
import { Refused } from "../../../../../kernel/index.js";
import { agentModel } from "../query.js";
import { appendProofCounter } from "../../../../../verify/index.js";
import { ensureProofCounters } from "../../../../../verify/index.js";

import { beginImmediateQueued } from "../busy.js";
import { boardTransactionBusyError } from "../busy.js";
import { beginCapture } from "../capture.js";
import {
  beginBoardWrite,
  finishBoardWrite,
  noteBoardWriteItem,
  prepareBoardWriteIdentity,
  prepareBoardWriteMarker,
} from "../write/lock.js";

import { BOARD_PROGRESS_ENGINE } from '../../../../../state/index.js';
import { suspendStoreGuards } from "../guards.js";
import { notifyUnblocked } from '../../../logic/board/notices.js';
import { fileSystemAdapter } from '../../../../../fs/index.js';
const fileSystem = fileSystemAdapter();

const OWN_FILE = fileURLToPath(import.meta.url);

/**
 * The first stack frame outside this module: the caller whose write body held the lock. Naming this module's own file
 * (as the old filename check did after the rename to log.js) reports every hold as this file's line [#2282,#6825].
 * @param {string|undefined} stack - An Error stack captured inside the transaction.
 * @param {string} [own] - The module path to skip; this module's own file unless a test names another.
 * @returns {Array<string>|undefined} Match groups: text, path, line.
 */
export function writeOrigin(stack, own = OWN_FILE) {
  return stack?.split('\n').slice(1).map(line => {
    const match = /(file:\/\/)?(\/[^\s():]+\.js):(\d+):\d+/u.exec(line);
    if (!match) return null;
    // A file URL percent-encodes a folder name with a space; decode it, or this module's own frame never equals OWN_FILE.
    let path = match[2];
    if (match[1]) try { path = decodeURIComponent(path); } catch { /* A malformed escape keeps the raw path. */ }
    return [match[0], path, match[3]];
  }).find(match => match && match[1] !== own);
}

const TRANSACTION_DEPTH = new WeakMap();
const AFTER_COMMIT = new WeakMap();

/** Defer sidecar work until the outer writer is released; rolled-back savepoints discard it. */
export function afterBoardWrite(board, work) {
  if ((TRANSACTION_DEPTH.get(board) ?? 0) > 0) AFTER_COMMIT.get(board).push(work);
  else work();
}

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
export function atomic(board, work, { reviewPolicy = true, writePolicy = true } = {}) {
  const depth = TRANSACTION_DEPTH.get(board) ?? 0;
  const savepoint = `pullboard_atomic_${depth}`;
  if (!depth) prepareBoardWriteIdentity();
  const startedAt = Date.now();
  let policy, writeRecord;
  if (depth) board.db.exec(`SAVEPOINT ${savepoint}`);
  else {
    for (let attempt = 0; ; attempt++) {
      // writePolicy: false is for writes no accepted policy judges (a lease heartbeat), so a policy landing mid-write never refuses them (#5672).
      policy = writePolicy ? board.prepareWritePolicy?.() : null;
      const marker = prepareBoardWriteMarker(board.db, board.writeContext);
      beginImmediateQueued(board.db, startedAt, marker);
      const bookkeepingAt = performance.now();
      writeRecord = beginBoardWrite(board.db, board.writeContext, marker);
      writeRecord.phase = 'write-bookkeeping';
      writeRecord.phaseMs = performance.now() - bookkeepingAt;
      let current;
      const policyAt = performance.now();
      try { current = !policy || policy.current(); }
      catch (error) {
        const elapsed = performance.now() - policyAt;
        if (elapsed > writeRecord.phaseMs) { writeRecord.phase = 'policy-admission'; writeRecord.phaseMs = elapsed; }
        board.db.exec('ROLLBACK');
        writeRecord.releasedAt = performance.now();
        finishBoardWrite(writeRecord, true, 'rolled-back');
        throw error;
      }
      const elapsed = performance.now() - policyAt;
      if (elapsed > writeRecord.phaseMs) { writeRecord.phase = 'policy-admission'; writeRecord.phaseMs = elapsed; }
      if (current) {
        const activateAt = performance.now();
        try { policy?.enter(); }
        catch (error) {
          const elapsed = performance.now() - activateAt;
          if (elapsed > writeRecord.phaseMs) { writeRecord.phase = 'policy-activation'; writeRecord.phaseMs = elapsed; }
          board.db.exec('ROLLBACK');
          writeRecord.releasedAt = performance.now();
          finishBoardWrite(writeRecord, true, 'rolled-back');
          throw error;
        }
        const elapsed = performance.now() - activateAt;
        if (elapsed > writeRecord.phaseMs) { writeRecord.phase = 'policy-activation'; writeRecord.phaseMs = elapsed; }
        break;
      }
      board.db.exec('ROLLBACK');
      writeRecord.releasedAt = performance.now();
      finishBoardWrite(writeRecord, true, 'rolled-back');
      if (attempt >= 3) throw new Refused('POLICY_SNAPSHOT_STALE', 'accepted policy changed before this write; retry the command against current main');
    }
  }
  if (!depth) AFTER_COMMIT.set(board, []);
  const deferred = AFTER_COMMIT.get(board);
  const deferredStart = deferred.length;
  TRANSACTION_DEPTH.set(board, depth + 1);
  const origin = writeOrigin(new Error().stack);
  const workPhase = origin ? `work:${origin[1].slice(origin[1].lastIndexOf('/') + 1)}:${origin[2]}` : 'work';
  // A local-first move records the rows it changed, so the relay's order can take it back later (#1013).
  let capture;
  let released = false;
  let outcome = 'release-failed';
  /** Measure only synchronous transaction phases; the log is written after release. */
  const phase = (name, fn) => {
    const start = performance.now();
    try { return fn(); } finally {
      const elapsed = performance.now() - start;
      const unmeasured = name.startsWith('work') ? Math.max(0, elapsed - (writeRecord?.workAccountedMs ?? 0)) : elapsed;
      if (writeRecord && unmeasured > (writeRecord.phaseMs ?? 0)) { writeRecord.phase = name; writeRecord.phaseMs = unmeasured; }
    }
  };
  const lastEvent = board.lastEvent;
  const reviewDefaultNotice = board.reviewDefaultNotice;
  const emitted = board.emittedEvents?.length ?? 0;
  try {
    capture = depth ? null : phase('capture', () => beginCapture(board.db));
    const result = phase(workPhase, work);
    if (reviewPolicy) phase('review-policy', () => board.runtimePorts.lifecycle.normalizeReviewDefaults(board));
    if (policy) phase('policy-validation', () => policy.assertCurrent());
    if (capture) phase('capture-prepare', () => capture.prepare());
    phase('commit', () => board.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT'));
    if (writeRecord) writeRecord.releasedAt = performance.now();
    released = true;
    outcome = 'committed';
    capture?.commit();
    return result;
  } catch (error) {
    if (!released) {
      board.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      if (writeRecord) writeRecord.releasedAt = performance.now();
      released = true;
      outcome = 'rolled-back';
      board.lastEvent = lastEvent;
      board.reviewDefaultNotice = reviewDefaultNotice;
      board.emittedEvents?.splice(emitted);
    }
    throw boardTransactionBusyError(board.db, startedAt, error);
  } finally {
    try { capture?.close(); }
    catch {
      // Cleanup must never discard a committed move's replication intent or replace its original failure.
      try { fileSystem.write(2, 'pullboard: capture session cleanup failed; original transaction outcome retained\n'); }
      catch { /* A closed diagnostic stream cannot change the committed result or original refusal. */ }
    }
    finally {
      policy?.leave();
      TRANSACTION_DEPTH.set(board, depth);
      finishBoardWrite(writeRecord, released, outcome);
      if (outcome !== 'committed') deferred.length = deferredStart;
      if (!depth) {
        AFTER_COMMIT.delete(board);
        if (outcome === 'committed') for (const work of deferred) work();
      }
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
 * @returns {object} This append's exact row, even when a conditional lift appends another row.
 */
export function logEvent(board, by, kind, itemId, detail = {}, at) {
  // Standalone native writers take the same actual lock; nested moves retain their existing savepoints.
  if (!(TRANSACTION_DEPTH.get(board) ?? 0)) return atomic(board, () => logEvent(board, by, kind, itemId, detail, at));
  noteBoardWriteItem(board.db, itemId);
  // A kind a newer engine declares is refused before anything is written, so an older board's history keeps its meaning [M1].
  const tooNew = eventKindRefusal(board, kind);
  if (tooNew) throw new Refused(tooNew.code, tooNew.message, tooNew.next);
  // A refused authenticated request remains auditable; it is not an outgoing board move.
  if (kind !== 'relay_refused') requireHandoffActive(board, by, kind, [{ item: kind === 'shout' ? detail.item : undefined }]);
  board.db.exec('SAVEPOINT proof_event_append');
  try {
    ensureProofCounters(board, { refresh: false });
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
    liftInfraHold(board, event, logEvent, setItem);
    liftTwiceHold(board, event, logEvent, setItem);
    liftSettledHolds(board, event, logEvent, setItem);
    if ((board.executionEngineVersion ?? ENGINE_VERSION) >= BOARD_PROGRESS_ENGINE && ['merged', 'withdraw', 'unhold_item', 'unhold'].includes(kind)) {
      notifyUnblocked(board, event, logEvent);
    }
    board.db.exec('RELEASE proof_event_append');
    return event;
  } catch (error) {
    board.db.exec('ROLLBACK TO proof_event_append; RELEASE proof_event_append');
    throw error;
  }
}


/**
 * Move every event of the named items into event_archive, stamped with `archivedAt`, in one transaction; returns how many moved.
 * Why here: this module is the one writer of the event tables, so the archiver asks it to move rows instead of writing them [#9334].
 * @param {any} board
 * @param {number[]} itemIds
 * @param {string} archivedAt - ISO time recorded on each archived row.
 * @returns {number}
 */
export function moveEventsToArchive(board, itemIds, archivedAt) {
  if (!itemIds.length) return 0;
  const ids = JSON.stringify(itemIds);
  return atomic(board, () => {
    // Events are append-only under the board's guards; the archive is the one sanctioned move out, so lift them for this transaction and put them back.
    const restore = suspendStoreGuards(board);
    const moved = board.db.prepare(`INSERT INTO event_archive (event_id, event_at, event_by, event_kind, item_id, event_detail, event_archived_at)
      SELECT event_id, event_at, event_by, event_kind, item_id, event_detail, ? FROM event WHERE item_id IN (SELECT value FROM json_each(?))`).run(archivedAt, ids).changes;
    board.db.prepare('DELETE FROM event WHERE item_id IN (SELECT value FROM json_each(?))').run(ids);
    restore();
    return Number(moved);
  });
}

/** Preserve the native clock fallback when conditional holds write item fields [M1,C7]. */
function setItem(board, id, fields, at) { return writeItemFields(board, id, fields, at, now); }
