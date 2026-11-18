/** @pullboard-module-loads packages/board/src/logic/ports.js */
/** The board's lazy provider loader and its view binding, apart from the barrel so a light door can name them without loading it [C7]. */
import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);
let composed = null;
let viewLoader = null;

/** The package providers, loaded on the first call that needs them: a board that only reads never pays for the ~600 modules behind them [C7]. */
export function providers() {
  if (composed) return composed;
  composed = requireModule('../logic/ports.js');
  composed.useBoardView(() => viewLoader);
  return composed;
}

/**
 * Name how the view app's projections load. The app above this package supplies it, so the board never imports an app [C7].
 * Until it is named, a projection call refuses rather than guess; the loader runs at the first projection, never here.
 */
export function bindBoardView(load) { viewLoader = typeof load === 'function' ? load : null; }
