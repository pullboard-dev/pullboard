/** Runtime preload policy surrounds the optional cache without entering the parser's source graph [C7]. */
import { importParseScopes } from '../../../codemap/index.js';
import { foreignNodeOptions } from './test/isolation.js';
import { environmentAdapter } from '../../../env/index.js';

/** Reuse real compile results within one census only while the current preload policy permits it. */
export function withImportParseCache(work, { directory = importParseScopes.getStore()?.directory } = {}) {
  return importParseScopes.run({ directory, epochs: new Map(), bytes: 0, entries: 0,
    /** Recheck actual options before every lookup, including an option change inside the census. */
    allowed: () => !foreignNodeOptions(environmentAdapter().get('NODE_OPTIONS')) }, work);
}
