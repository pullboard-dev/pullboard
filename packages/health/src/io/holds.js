/** The health line's slow-hold report: the live board's holds over 200 ms [C7,#3190]. */

/**
 * One line per live-board hold over 200 ms from the last hour, longest first, naming the command, seat and held time.
 * Why: only rows naming this board file count, so test boards in the same machine log are never blamed.
 *
 * @param {{ at: string, command: string, seat: string, heldMs: number, boardFile?: string|null }[]} rows - The machine hold log's rows.
 * @param {string} boardFile - The board database's real path, as the hold log records it.
 * @param {{ now?: number }} [options]
 * @returns {string[]}
 */
export function slowHoldLines(rows, boardFile, { now = Date.now() } = {}) {
  return rows
    .filter(row => row.boardFile === boardFile && Number.isSafeInteger(row.heldMs) && row.heldMs > 200
      && Date.parse(row.at) >= now - 3_600_000 && Date.parse(row.at) < now)
    .sort((a, b) => b.heldMs - a.heldMs).slice(0, 5)
    .map(row => `slow board hold: ${row.command} by ${row.seat} held the board ${row.heldMs} ms at ${row.at.slice(0, 16).replace('T', ' ')}`);
}
