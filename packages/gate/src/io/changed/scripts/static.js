/** Execute the shared gate-cell static checker with the hook's exact staged source, plus the gate's test fixture and test-name checks [C7]. */
import { fileURLToPath } from 'node:url';
import { changedStaticFailures } from '../static.js';
import { stagedHookFailures as gateStagedFailures } from '../static.js';
import { fixtureGrowthIn } from '../../test/fixtures.js';
import { testNameSites } from '../../test/names.js';
import { TEST_FILE } from '../../scan.js';
export { changedStaticFailures } from '../static.js';

const FIXTURE_CEILINGS = 'packages/gate/data/tests/test-fixtures.json';

/** True for a test file the gate's tree walk visits: it skips node_modules, work and dot directories. */
function walkedTestName(file) {
  return TEST_FILE.test(file) && !file.split('/').some(part => part === 'node_modules' || part === 'work' || part.startsWith('.'));
}

/**
 * The test checks the gate static stage runs on the whole tree (test-fixtures, and doctrine T5's test-names), judged on
 * the changed files only with the gate's messages. Why: 15 of 19 red gates on 7 Nov were these, found ten minutes after
 * submit; at commit they cost milliseconds. A change with no test files reads nothing [C7].
 */
export const STAGED_TEST_CHECKS = Object.freeze([
  { name: 'test-fixtures', run: ({ files, text, previous }) => fixtureGrowthIn(files, { text, previous, ceilings: () => {
    let source;
    try { source = text(FIXTURE_CEILINGS); } catch { return {}; } // a checkout without the ceilings file holds no ratchet; every site is new
    return JSON.parse(source);
  } }).map(row => `${row.path}:${row.line}: ${row.text}`) },
  { name: 'test-names', run: ({ files, text, previous }) => files.filter(walkedTestName)
    .flatMap(file => testNameSites(text(file), file).slice(testNameSites(previous(file), file).length))
    .map(row => `${row.path}:${row.line}: ${row.text}`) },
]);

/**
 * The pre-commit hook's check: the gate's changed-file static list plus STAGED_TEST_CHECKS, on the exact index bytes.
 *
 * @param {string} root - Checkout root.
 * @returns {string[]} One `path:line: message` per failure; empty when clean.
 */
export function stagedHookFailures(root) {
  return gateStagedFailures(root, { also: STAGED_TEST_CHECKS });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staged = process.argv[2] === '--staged';
  const failures = process.argv[2] === '--staged-hook' ? stagedHookFailures(process.cwd())
    : changedStaticFailures(process.cwd(), process.argv.slice(staged ? 3 : 2), { staged });
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
}
