/** Preserve the original CI engine export for callers after its declaration moved to its own leaf (#918). */
export { CI_FLAKE_ENGINE } from './ci-flake-engine.js';

/** Coordinator allocation17419: typed Native flake observations start here [H16]. */
export const NATIVE_FLAKE_ENGINE = 61;

/** Recognize new landing receipt relationships without interpreting malformed batch input. */
export function carriesFlakeDiagnostics(batch) {
  return Boolean(batch && (Object.hasOwn(batch, 'flakeDiagnostics')
    || Array.isArray(batch.gateResults) && batch.gateResults.some(result => result && Object.hasOwn(result, 'flakeDiagnostics'))));
}
