/** The review folder dependency cache key is the sha256 of package-lock.json [C7,#1112]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { lockfileCacheKey } from "../../src/io/review-folder-cache.js";

/** A private folder, removed after the test, holding a package-lock.json when `lock` is given. */
function folder(t, lock) {
  const dir = privateFixtureFiles('review-folder-cache-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (lock !== undefined) writeFileSync(join(dir, 'package-lock.json'), lock);
  return dir;
}

test('git.review-folder-cache.key-follows-lockfile-bytes: clause 1: lockfileCacheKey returns one key for identical package-lock.json bytes and another when one byte differs [C7,#1112]', t => {
  const bytes = '{"name":"x","lockfileVersion":3}\n';
  const a = lockfileCacheKey(folder(t, bytes));
  assert.match(a, /^[0-9a-f]{64}$/u);
  assert.equal(lockfileCacheKey(folder(t, bytes)), a, 'identical bytes give the same key');
  assert.notEqual(lockfileCacheKey(folder(t, bytes.replace('x', 'y'))), a, 'one different byte gives a different key');
});

test('git.review-folder-cache.no-lockfile-refuses: clause 2: lockfileCacheKey refuses naming package-lock.json when the folder has no lockfile [C7,#1112]', t => {
  assert.throws(() => lockfileCacheKey(folder(t)), error => error.name === 'Refused' && error.code === 'NO_FILE' && error.message.includes('package-lock.json'));
});
