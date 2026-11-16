/** The companion's rule for a pulled gate whose every red case also fails on main [V4,B3,C7]. */

/** The check that a companion left every failing test's input closure alone; null until a host provides one. */
let untouched = null;

/**
 * Provide companionMainFailuresUntouched(root, { base, source, composed }, failures) from the landing cell.
 * Why a provider: the closure check lives in landing, and `pullboard serve` calls this once at start, so the board
 * API adds no edge to it, as provideMainComparison does [C7].
 * @param {((root: string, commits: { base: string, source: string, composed: string }, failures: { file: string }[]) => boolean) | null} check
 */
export function provideCompanionInheritance(check) {
  untouched = typeof check === 'function' ? check : null;
}

/**
 * Whether a submit may inherit main's red cases as the pulled gate found them. A plain submit always may. A companion
 * submit may only when its frozen check passed and its companions changed no input of any failing test, as the
 * controller's submit judged it before #6832 moved every gate to a pull job [V4,B3,C7].
 * Why: a companion's bytes never ran on main, so a red they could reach is not main's; without a host's check, or
 * without the board's repository, nothing is inherited.
 * @param {{ gitRoot?: string }} board
 * @param {{ companion?: { source?: string, commit?: string } | null }} submit
 * @param {string} main
 * @param {{ phase: string, file: string }[]} cases
 * @returns {boolean}
 */
export function companionInherits(board, submit, main, cases) {
  if (!submit?.companion) return true;
  if (!untouched || !board.gitRoot || cases.some(row => row.phase !== 'proof')) return false;
  try {
    return untouched(board.gitRoot, { base: main, source: submit.companion.source, composed: submit.companion.commit }, cases) === true;
  } catch { return false; } // Unreadable Git or graph evidence never grants known-main acceptance.
}
