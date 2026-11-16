/** Event kinds a board may record only from the engine that declares them [M1]. */
import { engineAtLeast } from './minimum.js';
import { engineNumber } from './number.js';

/**
 * Each gated event kind by the engine leaf that declares it.
 * Why: a board recorded below that engine has never seen the kind, so replaying it there would change history.
 */
export const EVENT_KIND_ENGINES = Object.freeze({
  pull_out: 'LANDING_DIMENSION_ENGINE',
  pulled: 'LANDING_DIMENSION_ENGINE',
  published: 'LANDING_DIMENSION_ENGINE',
});

/**
 * The engine number that declares an event kind, or null for a kind every engine may write.
 *
 * @param {string} kind
 * @returns {number | null}
 */
export function eventKindEngine(kind) {
  return Object.hasOwn(EVENT_KIND_ENGINES, kind) ? engineNumber(EVENT_KIND_ENGINES[kind]) : null;
}

/**
 * The refusal for an event kind the board's engine does not declare yet, or null; every ungated kind passes.
 * Why pure: the store's event log throws it, so this cell stays free of the kernel.
 *
 * @param {{ executionEngineVersion?: number }} board
 * @param {string} kind
 * @returns {{ code: 'ENGINE_VERSION', message: string, next: string } | null}
 */
export function eventKindRefusal(board, kind) {
  const engine = eventKindEngine(kind);
  if (engine === null || engineAtLeast(board, engine)) return null;
  return { code: 'ENGINE_VERSION', message: `a ${kind} event requires engine ${engine}; this board records engine ${board.executionEngineVersion}; upgrade Pullboard before recording one`,
    next: 'upgrade Pullboard, then run the move again' };
}
