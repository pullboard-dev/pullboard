/**
 * Whether a board runs at or above an engine, without reading the engine folder [H16,C7].
 *
 * At its origin a board has no executionEngineVersion and runs every engine this code declares, so any engine
 * a caller names is in force; a replica replaying a recorded move runs exactly that move's engine. This is the
 * same test as (board.executionEngineVersion ?? ENGINE_VERSION) >= engine for every declared engine, because
 * ENGINE_VERSION is the highest of them.
 *
 * @param {{ executionEngineVersion?: number }} board
 * @param {number} engine
 * @returns {boolean}
 */
export function engineAtLeast(board, engine) {
  return board.executionEngineVersion == null || board.executionEngineVersion >= engine;
}
