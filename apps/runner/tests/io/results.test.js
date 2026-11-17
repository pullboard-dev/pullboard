/** A runner prunes its test-results store by age and size, skipping repo stores a live job holds [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { maintainTestResults } from '../../src/io/results.js';
import { pruneTestResults } from '../../src/io/results.js';

const HOUR = 60 * 60_000;
const REPO = 'a'.repeat(64);
const HELD = 'b'.repeat(64);

/** Write a record of a given size and age under a repo store's inputs folder. */
function record(root, repo, key, kilobytes, ageMs, now) {
  const directory = join(root, 'test-results', repo, 'inputs', key);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'r.json');
  writeFileSync(file, Buffer.alloc(kilobytes * 1024, 1));
  const when = (now - ageMs) / 1000;
  utimesSync(file, when, when);
  utimesSync(directory, when, when);
  return directory;
}

test('runner.results.old-runner-test-results-are-pruned: clause 1: old runner test results are pruned [C7]', () => {
  const now = Date.now();
  const { root } = privateFixtureFiles('pb-results-prune-');
  const old = record(root, REPO, 'old', 8, 7 * HOUR, now);
  const fresh = record(root, REPO, 'fresh', 8, HOUR, now);
  const inFlight = record(root, REPO, 'writing', 8, 0, now);
  const held = record(root, HELD, 'held-old', 8, 9 * HOUR, now);
  const result = pruneTestResults(root, { now, held: new Set([HELD]) });
  assert.equal(existsSync(old), false, 'a record older than the 6 h default age is removed');
  assert.equal(existsSync(fresh), true, 'a record younger than the age cap stays');
  assert.equal(existsSync(inFlight), true, 'a record being written now stays');
  assert.equal(existsSync(held), true, 'a repo store an in-flight job holds is never pruned, however old');
  assert.equal(result.removed, 1);

  const oldest = record(root, REPO, 'oldest', 8, 3 * HOUR, now);
  const capped = pruneTestResults(root, { now, capBytes: 20 * 1024, held: new Set([HELD]) });
  assert.equal(existsSync(oldest), false, 'over the size cap, the oldest idle record goes first');
  assert.equal(existsSync(inFlight), true, 'the cap never removes a record inside the grace period');
  assert.ok(capped.removed >= 1);

  const configured = record(root, REPO, 'configured', 8, 2 * HOUR, now);
  maintainTestResults(root, { env: { PULLBOARD_RUNNER_TEST_RESULTS_MAX_AGE_MS: String(HOUR) }, now });
  assert.equal(existsSync(configured), false, 'the age cap is configurable');
});

test('runner.results.the-prune-runs-once-per-interval-and: the prune runs once per interval and one worker wins the claim [C7]', () => {
  const now = Date.now();
  const { root } = privateFixtureFiles('pb-results-prune-');
  const old = record(root, REPO, 'old', 8, 7 * HOUR, now);
  assert.ok(maintainTestResults(root, { now }), 'the first worker prunes');
  assert.equal(existsSync(old), false);
  const again = record(root, REPO, 'again', 8, 7 * HOUR, now);
  assert.equal(maintainTestResults(root, { now }), null, 'a second call inside the interval does nothing');
  assert.equal(existsSync(again), true);
});
