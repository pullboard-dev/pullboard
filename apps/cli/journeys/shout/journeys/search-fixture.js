import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureProjectPolicy } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

/** Shared helpers for the cockpit search row-age tests, split out of search.test.js (#4001). */

/** Quote one POSIX shell word so fixture paths preserve spaces and shell metacharacters. */
export function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Rewrite a fixture repository's SPEC.md through the policy helper, keeping its pullboard.json as it is. */
export function writeSpec(repo, spec) {
  fixtureProjectPolicy(repo, { config: JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8')), spec });
}

/** Make the private browser profile folder the moving-capture test hands to Chrome. */
export function makeProfile() {
  return privateFixtureFiles('pullboard-moving-capture-').root;
}
