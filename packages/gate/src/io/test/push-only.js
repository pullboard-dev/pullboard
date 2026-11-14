/** The test files only the pre-push full gate runs, read from packages/gate/data/tests/push-only.json [R4,C7]. */
import { readFileSync } from 'node:fs';

const LISTING = new URL('../../../data/tests/push-only.json', import.meta.url);

/**
 * The test files an item's gates leave to the full gate: listed by repository-relative path in the data file, never in code.
 * Why: a journey that upgrades a whole board costs minutes, so every item gate paying for it would slow every landing; the
 * pre-push full gate plans every tracked test file and runs it once per push.
 *
 * @returns {string[]} The sorted paths.
 */
export function pushOnlyTests() {
  const listing = JSON.parse(readFileSync(LISTING, 'utf8'));
  return [...new Set(Array.isArray(listing.files) ? listing.files.filter(file => typeof file === 'string' && file) : [])].sort();
}
