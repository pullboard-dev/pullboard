/**
 * The board-engine moves a pulled gate's receipt makes, ordered through the relay on a relay-linked board [C7,H3,H16].
 *
 * Why: the board API applies a receipt with direct store writes. On a local board that is the whole story, but on a
 * relay-linked replica those writes stayed on the one machine whose runner pulled the gate, so every other replica
 * kept the item claimed (#7562). A linked board's apply runs as usual, so its reads and refusals are unchanged, then
 * the engine moves it made are taken back and handed to the caller, who orders them through the relay like any other
 * move; the rows that are no engine move (a stored receipt, a queued job) stay as they were made.
 */
import * as boardStore from '../../../../store/index.js';

/** The engine moves a gate receipt makes: what another replica must see. */
const RECEIPT_MOVES = Object.freeze(['submit', 'appendFact', 'shout', 'recordProofRun', 'deferOwnership']);

/** The recorder for each board whose receipt is being applied for the relay; absent, a move applies at once. */
const RECORDERS = new WeakMap();

/** The savepoint a linked apply's rows are taken back to. */
const SAVEPOINT = 'pullboard_receipt_moves';

/** SQLite's changeset conflict answer that leaves the conflicting change out. */
const OMIT = 0;

/**
 * Make one gap's rows again; a row that leaned on an engine move taken back is left out, as the relay's order makes it again.
 * Why two forms: newer Node takes onConflict only as a function, Node 22.13 only as a number.
 */
function applyGap(db, gap) {
  try { db.applyChangeset(gap, { onConflict: () => OMIT }); }
  catch (error) {
    if (error?.code !== 'ERR_INVALID_ARG_TYPE' || !String(error.message).includes('onConflict')) throw error;
    db.applyChangeset(gap, { onConflict: OMIT });
  }
}

/**
 * Make one engine move: at once on a local board; inside orderedReceiptMoves also recorded, with the rows made since
 * the last engine move kept as a changeset, so only the engine moves are taken back.
 *
 * @param {string} operation
 * @returns {(board: any, ...args: any[]) => any}
 */
function receiptMove(operation) {
  return (board, ...args) => {
    const recorder = RECORDERS.get(board);
    if (!recorder || recorder.inside) return boardStore[operation](board, ...args);
    // The arguments as the move was asked for, before the store's own writer reads or fills them.
    const sent = structuredClone(args);
    recorder.gaps.push(recorder.session.changeset());
    recorder.session.close();
    recorder.inside = true;
    try {
      const result = boardStore[operation](board, ...args);
      recorder.moves.push({ operation, args: sent });
      return result;
    } finally {
      recorder.inside = false;
      recorder.session = board.db.createSession();
    }
  };
}

/** The store as a receipt's apply uses it: every read and write as the store makes it, the engine moves through receiptMove. */
export const store = Object.freeze({ ...boardStore, ...Object.fromEntries(RECEIPT_MOVES.map(operation => [operation, receiptMove(operation)])) });

/**
 * Run a receipt's apply on a relay-linked board and return the engine moves it made, taken back off this replica so
 * the caller orders them through the relay, where this replica applies them in the relay's order like every other.
 * Rows it made that are no engine move are kept. With no engine move made, everything it made is kept as it was.
 *
 * @template T
 * @param {any} board
 * @param {() => T} work - The apply, as it runs on a local board.
 * @returns {{ result: T, moves: { operation: string, args: any[] }[] }}
 */
export function orderedReceiptMoves(board, work) {
  if (RECORDERS.has(board)) return { result: work(), moves: [] };
  return boardStore.atomic(board, () => {
    const { db } = board;
    db.exec(`SAVEPOINT ${SAVEPOINT}`);
    const recorder = { moves: [], gaps: [], inside: false, session: db.createSession() };
    RECORDERS.set(board, recorder);
    let result;
    try {
      result = work();
      recorder.gaps.push(recorder.session.changeset());
    } catch (error) {
      db.exec(`ROLLBACK TO ${SAVEPOINT}`);
      throw error;
    } finally {
      recorder.session.close();
      RECORDERS.delete(board);
    }
    if (recorder.moves.length) {
      db.exec(`ROLLBACK TO ${SAVEPOINT}`);
      for (const gap of recorder.gaps) if (gap.length) applyGap(db, gap);
    }
    db.exec(`RELEASE ${SAVEPOINT}`);
    return { result, moves: recorder.moves };
  });
}
