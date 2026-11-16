/**
 * The CLI's door to the board-and-runs reconciler: one settling pass for `pullboard doctor`, a paced loop for `pullboard serve` [B2,P7].
 *
 * Why: the reconciler tick landed as library code (#7416); this is the wiring its design names (runner-store-design.md
 * section 2). Both doors do nothing, and open no runs file, while the board's runs_store flag is off.
 */
import { startBeat } from '../../../../packages/drive/index.js';
import { boardId } from '../../../../packages/store/index.js';
import { boardRunsPort } from '../../../../packages/store/index.js';
import { openRunsStore } from '../../../../packages/store/index.js';
import { runsFilePath } from '../../../../packages/store/index.js';
import { reconcileTick } from '../../../../packages/store/index.js';
import { pacedReconciler } from '../../../../packages/store/index.js';
import { RECONCILE_EVERY_MS } from '../../../../packages/store/index.js';

/** How often the serve loop looks at the pace; the pace itself still holds ticks to one per RECONCILE_EVERY_MS. */
const POLL_MS = 1000;

/**
 * Run one reconciler tick on an open, writable board.
 *
 * @param {any} board - The open board.
 * @param {string} boardFile - The board's file path, which names the runs file beside it.
 * @param {{ by?: string }} [options]
 * @returns {{ job: string, action: string }[]|null} The jobs the tick settled, or null while the runs_store flag is off.
 */
export function settleOnce(board, boardFile, { by = 'coordinator' } = {}) {
  const port = boardRunsPort(board, boardFile);
  if (!port) return null;
  const runs = { db: openRunsStore(runsFilePath(boardFile), { boardId: boardId(board) }) };
  try { return reconcileTick(board, runs, port, { by }); } finally { runs.db.close(); }
}

/** The line doctor prints for a tick's result, or null when the flag is off so doctor prints no reconciler line. */
export function reconcilerLine(settled) {
  if (settled === null) return null;
  if (!settled.length) return 'reconciler: the board and the runs file agree; nothing to settle';
  return `reconciler: settled ${settled.map(row => `${row.job} (${row.action})`).join(', ')}`;
}

/**
 * The serve loop's reconciler: a timer that offers a tick every second to a pace that lets one through per 5 s.
 * The board opens only when a tick is due.
 *
 * @param {{ withBoard: (work: (board: any) => any) => any, boardFile: string, clock?: () => number, every?: number,
 *   onSettled?: (settled: object[]) => void, onError?: (error: Error) => void }} options
 * @returns {{ offer: () => void, stop: () => void }} `offer` is one timer beat, exposed so tests need no wall clock.
 */
export function serveReconciler({ withBoard, boardFile, clock = Date.now, every = RECONCILE_EVERY_MS, onSettled, onError }) {
  const paced = pacedReconciler(() => withBoard(board => settleOnce(board, boardFile)), { every, clock });
  const offer = () => {
    try {
      const settled = paced();
      if (settled?.length) onSettled?.(settled);
    } catch (error) { onError?.(error); }
  };
  return { offer, stop: startBeat(offer, POLL_MS).stop };
}
