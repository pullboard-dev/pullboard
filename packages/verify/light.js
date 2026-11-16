export { receiptFields, runTimingFields, sameEnvironment, testRuntimeEnvironment, testRuntimeRows } from './src/logic/proof/provenance.js';

/** The proof counters, rule counts and review queue line a status read prints, without the rest of the verify cell [C7,#8645]. */
export { currentProofCounters, proofCounter } from './src/io/proof/counters.js';
export { ruleProofCounts } from './src/io/rule/proof/counts.js';
export { bindProofRunner } from './src/io/rule/proof/coverage.js';
export { reviewQueueLine } from './src/logic/review/queue.js';

/** Normalize bounded per-test facts; malformed or duplicate identities grant no quarantine evidence. */
export function testOutcomeFields(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100000) return null;
  const keys = new Set(), rows = [];
  for (const row of value) {
    if (!row || !/^(failure,)?file,name,passed,skipped$/u.test(Object.keys(row).sort())
      || 'failure' in row && (!/^(assertion|error)$/u.test(row.failure) || row.passed || row.skipped)
      || typeof row.file !== 'string' || !row.file || row.file.length > 4096
      || row.file.startsWith('/') || /^[A-Za-z]:/u.test(row.file) || /[\\\r\n\0]/u.test(row.file)
      || row.file.split('/').some(part => !part || part === '.' || part === '..')
      || typeof row.name !== 'string' || !row.name || row.name.length > 8192 || /[\r\n\0]/u.test(row.name)
      || typeof row.passed !== 'boolean' || typeof row.skipped !== 'boolean') return null;
    const key = JSON.stringify([row.file, row.name]);
    if (keys.has(key)) return null;
    keys.add(key);
    rows.push({ ...row });
  }
  return rows;
}
