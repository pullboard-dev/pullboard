/** Runtime preload policy surrounds the optional cache without entering the parser's source graph [C7]. */
import { importParseScopes } from './module-import-cache-state.js';
import { foreignNodeOptions } from './test-isolation.js';

/** Reuse real compile results within one census only while the current preload policy permits it. */
export function withImportParseCache(work) {
  if (foreignNodeOptions(process.env.NODE_OPTIONS)) return work();
  return importParseScopes.run({ epochs: new Map(), bytes: 0, entries: 0,
    /** Recheck actual options before every lookup, including an option change inside the census. */
    allowed: () => !foreignNodeOptions(process.env.NODE_OPTIONS) }, work);
}
