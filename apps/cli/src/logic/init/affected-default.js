/** The affected-test command init records for a repo with exactly one detected language that has a per-file test command [C7]. */
import { affectedRow } from '../../../../../packages/gate/index.js';

/**
 * The affectedTests setting init writes into a new pullboard.json: the language row's command and selection unit when exactly one
 * language was detected and its affected row has a command; null for two or more languages, a language with no row (make, cobol) and none.
 * Why: without it a fresh node repo refuses NO_TEST_RUNNER on every pullboard test <file>, and each builder edited pullboard.json by hand.
 *
 * @param {readonly { language: string }[]} entries - What detectLanguages returned.
 * @returns {{ affectedTests: string, selectionUnit: string } | null} The default, or null.
 */
export function affectedDefault(entries) {
  const names = [...new Set((entries ?? []).map(entry => entry.language))];
  if (names.length !== 1) return null;
  const row = affectedRow(names[0]);
  return row.affectedTests ? { affectedTests: row.affectedTests, selectionUnit: row.selectionUnit } : null;
}

/**
 * The config with affectedTests filled from the default only when the key is absent; a set value is never overwritten.
 *
 * @param {object} config - The new pullboard.json content.
 * @param {readonly { language: string }[]} entries - What detectLanguages returned.
 * @param {{ scripts?: { test?: string } } | null} [pkg] - The repo root package.json, when it has one.
 * @returns {object} The same config, or a copy with affectedTests added.
 */
export function withAffectedDefault(config, entries, pkg = null) {
  if (config.affectedTests !== undefined) return config;
  if (namesOtherRunner(pkg)) return config;
  const found = affectedDefault(entries);
  return found ? { ...config, affectedTests: found.affectedTests } : config;
}

const OTHER_RUNNERS = /\b(jest|vitest|mocha|ava|tap|jasmine|karma|playwright|cypress)\b/;

/**
 * Whether the package's test script names a runner other than node:test.
 * Why: node --test over files written for another runner fails with "describe is not defined", so init leaves the key unset there.
 *
 * @param {{ scripts?: { test?: string } } | null | undefined} pkg - The parsed package.json.
 * @returns {boolean} True when the test script names jest, vitest, mocha or another known runner.
 */
function namesOtherRunner(pkg) {
  const script = pkg?.scripts?.test;
  return typeof script === 'string' && OTHER_RUNNERS.test(script);
}
