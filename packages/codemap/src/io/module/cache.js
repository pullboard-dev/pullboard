/** Private census storage keeps the compile-only parser independent of runtime setup [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';

export const importParseScopes = new AsyncLocalStorage();
