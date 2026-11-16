/** Flag two registered tests that prove the same claim, so a claim has one test [C7,U148]. */
import { readFileSync } from 'node:fs';
import { Refused } from '../../../../kernel/index.js';

/** A claim compared the way a reader would: case, spacing and a closing full stop do not make two claims. */
function normalized(claim) {
  return String(claim).toLowerCase().replace(/\s+/gu, ' ').trim().replace(/\.$/u, '');
}

/**
 * The claims that more than one test carries.
 * Why: the standard for having a test says no other test proves the same claim; the registry records are where each test states its claim.
 *
 * @param {Record<string, { proves?: { claim?: string } }>} records Registry records keyed by test ID.
 * @returns {{ claim: string, ids: string[] }[]} One entry per shared claim, IDs sorted.
 */
export function duplicateClaims(records) {
  const seen = new Map();
  for (const [id, record] of Object.entries(records)) {
    const claim = record?.proves?.claim;
    if (typeof claim !== 'string' || !normalized(claim)) continue;
    seen.set(normalized(claim), [...(seen.get(normalized(claim)) ?? []), id]);
  }
  return [...seen].filter(([, ids]) => ids.length > 1).map(([claim, ids]) => ({ claim, ids: ids.sort() }));
}

/**
 * Refuse when two records in one registry file carry the same claim.
 *
 * @param {string} registryFile Path to a cell's registry.json.
 * @throws {Refused} DUPLICATE_TEST_CLAIM, naming both IDs and what to do next.
 */
export function requireUniqueClaims(registryFile) {
  const [first] = duplicateClaims(JSON.parse(readFileSync(registryFile, 'utf8')));
  if (!first) return;
  throw new Refused('DUPLICATE_TEST_CLAIM', `${first.ids.join(' and ')} both prove: ${first.claim}`, `merge ${first.ids.join(' and ')} into one test, or retire one, then run the check again`);
}
