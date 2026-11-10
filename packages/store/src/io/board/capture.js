/**
 * Change capture (#1013): while `captureBoardChanges` runs, every outermost board transaction records the exact
 * rows it changed as a SQLite changeset, so a local-first move made ahead of the relay's order can later be taken
 * back row for row instead of restoring the whole board.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Each asynchronous operation owns its capture, including across interleaved awaits. */
const CAPTURES = new AsyncLocalStorage();

/**
 * Run `work`, collecting the changeset of every board transaction it commits, in order.
 *
 * @template T
 * @param {() => Promise<T> | T} work
 * @returns {Promise<{ result: T, changes: Uint8Array[] }>}
 */
export async function captureBoardChanges(work) {
  const changes = [];
  const context = { changes, active: true };
  return CAPTURES.run(context, async () => {
    try { return { result: await work(), changes }; }
    finally { context.active = false; } // Detached descendants cannot extend an already returned capture.
  });
}

/**
 * Start recording one outermost board transaction when a capture is running; returns how to finish it.
 * Why: a session sees only the rows its own connection changes, so each transaction opens its own on its board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ prepare: () => void, commit: () => void, close: () => void } | null}
 */
export function beginCapture(db) {
  const into = CAPTURES.getStore();
  if (!into?.active) return null;
  const session = db.createSession();
  let prepared;
  return {
    // Serialization can fail: do it while the transaction can still roll back.
    prepare() { prepared = session.changeset(); },
    // Only successful COMMIT publishes bytes; a failed COMMIT cannot leak an undone move.
    commit() { if (prepared.length) into.changes.push(prepared); },
    close() { session.close(); },
  };
}
