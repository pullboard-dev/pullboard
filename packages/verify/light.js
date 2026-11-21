export { receiptFields, runTimingFields, sameEnvironment, testRuntimeEnvironment, testRuntimeRows } from './src/logic/proof/provenance.js';

/** A repository-relative, slash-separated source path: the shape a row's file and owner must both have. */
function sourcePath(path) {
  return typeof path === 'string' && !!path && path.length <= 4096
    && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && !/[\\\r\n\0]/u.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}

/**
 * Normalize bounded per-test facts; malformed or duplicate identities grant no quarantine evidence. A row may name
 * the wrapper test file that ran it as `owner`, which never changes its `file` or its identity [C7].
 */
export function testOutcomeFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100000) return null;
  const keys = new Set(), rows = [];
  for (const row of value) {
    if (!row || !/^(failure,)?file,name,(owner,)?passed,skipped$/u.test(Object.keys(row).sort())
      || 'failure' in row && (!/^(assertion|error)$/u.test(row.failure) || row.passed || row.skipped)
      || !sourcePath(row.file) || 'owner' in row && !sourcePath(row.owner)
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || /[\r\n\0]/u.test(row.name)
      || typeof row.passed !== 'boolean' || typeof row.skipped !== 'boolean') return null;
    const key = JSON.stringify([row.file, row.name]);
    if (keys.has(key)) return null;
    keys.add(key);
    rows.push({ ...row });
  }
  return rows;
}
export { bindProofRunner } from './src/io/rule/proof/coverage.js';
export { reviewQueueLine } from './src/logic/review/queue.js';
