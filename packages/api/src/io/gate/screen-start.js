/** The screen starter a gate receipt calls when it records a sprint item's submission; `pullboard serve` hands it in beside the landing starter [V2,M1,#12174]. */

import { itemPace } from '../../../../store/index.js';

/** The screen starter this process's board API calls; null until a host provides one. */
let screenStarter = null;

/**
 * Provide the function that starts the screen job for a submitted sprint item: start({ root, item, commit, digest, trunk }).
 * `pullboard serve` hands in a start that runs runScreenJob from the drive cell, which stores the receipt and ends the job at done.
 * Why a provider: the screen merges the item onto the trunk and runs the static and trusted checks with the CLI's tools,
 * so `pullboard serve` hands it in beside the landing starter and the board API keeps no import of the CLI [V2,M1].
 * @param {((request: { root: string, item: number, commit: string, digest: string | null, trunk: string }) => unknown) | null} start
 */
export function provideScreenStart(start) {
  screenStarter = typeof start === 'function' ? start : null;
}

/**
 * Start the screen for an item a green gate receipt just recorded as submitted, when its frozen pace is sprint, once the
 * receipt's writes are done, with its commit, frozen digest and the trunk tip the gate ran on. Why: sprint lands submitted work
 * after a green screen, and nothing started one, so a sprint item waited for a verdict like a steady one. The pace is read from
 * the row the receipt apply already loaded, so a steady or strict item, or a board with no starter, makes no added board call.
 * A failed start is logged, never thrown into the receipt apply. onGreen runs once the started screen answers with a green receipt.
 * @param {{ gitRoot?: string }} board
 * @param {{ item_id: number, item_status: string, item_commit?: string, item_frozen_digest?: string, item_frozen?: string } | null | undefined} item
 * @param {string} trunk
 * @param {(() => void) | null} [onGreen]
 * @returns {boolean} whether a start was scheduled
 */
export function startReceiptScreen(board, item, trunk, onGreen = null) {
  const start = screenStarter;
  if (!start || item?.item_status !== 'submitted' || itemPace(item) !== 'sprint') return false;
  if (!board.gitRoot || !item.item_commit) return false;
  const request = { root: board.gitRoot, item: item.item_id, commit: item.item_commit, digest: item.item_frozen_digest ?? null, trunk };
  setImmediate(() => {
    // A screen that applies green starts the lander, as an accept would; a red or pending one starts nothing [#12176].
    Promise.resolve().then(() => start(request)).then(screened => { if (screened?.result?.green === true) onGreen?.(); }).catch(error => {
      process.stderr.write(`${new Date().toISOString()} screen for #${item.item_id} not started after its gate receipt: ${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
    });
  });
  return true;
}
