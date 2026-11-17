/** The runner results pruner also prunes each repo store's lists folder, and keeps a held store's lists [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { pruneTestResults } from '../../src/io/results.js';

const HOUR = 60 * 60_000;
const REPO = 'a'.repeat(64);
const HELD = 'b'.repeat(64);

/** Write a lists entry of a given size and age under a repo store. */
function list(root, repo, name, kilobytes, ageMs, now) {
  const directory = join(root, 'test-results', repo, 'lists');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, Buffer.alloc(kilobytes * 1024, 1));
  const when = (now - ageMs) / 1000;
  utimesSync(file, when, when);
  return file;
}

test('runner.results-lists.lists-entries-past-the-age-limit-and: clause 1: lists entries past the age limit and size cap are removed, oldest first [C7]', () => {
  const now = Date.now();
  const { root } = privateFixtureFiles('pb-results-lists-');
  const old = list(root, REPO, 'old.json', 8, 7 * HOUR, now);
  const fresh = list(root, REPO, 'fresh.json', 8, HOUR, now);
  const result = pruneTestResults(root, { now });
  assert.equal(existsSync(old), false, 'a lists entry older than the 6 h default age is removed');
  assert.equal(existsSync(fresh), true, 'a lists entry younger than the age cap stays');
  assert.equal(result.removed, 1);
  const older = list(root, REPO, 'older.json', 8, 3 * HOUR, now);
  pruneTestResults(root, { now, capBytes: 12 * 1024 });
  assert.equal(existsSync(older), false, 'over the size cap the oldest lists entry goes first');
  assert.equal(existsSync(fresh), true, 'the newer entry fits under the cap and stays');
});

test('runner.results-lists.a-list-inside-a-repo-store-held: clause 2: a list inside a repo store held by a live job is kept [C7]', () => {
  const now = Date.now();
  const { root } = privateFixtureFiles('pb-results-lists-held-');
  const held = list(root, HELD, 'held-old.json', 8, 9 * HOUR, now);
  const idle = list(root, REPO, 'idle-old.json', 8, 9 * HOUR, now);
  pruneTestResults(root, { now, held: new Set([HELD]) });
  assert.equal(existsSync(held), true, 'a held repo store keeps its lists however old');
  assert.equal(existsSync(idle), false, 'an idle repo store loses its old lists');
});
