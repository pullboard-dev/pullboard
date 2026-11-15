/** The CLI keeps compiled module code per machine and still runs when that folder is unusable [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';
import { runHelpAt } from './fixtures/compile-cache.js';

/** Every file under a folder with its modified time, for comparing two states of the cache. */
function listing(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); found.push(`${path} ${statSync(path).mtimeMs}`); }
  }
  return found.sort();
}

test('a second run reuses the first run\'s compiled modules from compile-cache under the machine home [C7]', () => {
  const home = privateFixtureFiles('pullboard-compile-cache-').root;
  try {
    assert.equal(runHelpAt(home).status, 0);
    const first = listing(join(home, 'compile-cache'));
    assert.ok(first.length > 0, 'the first run stored compiled modules');
    assert.equal(runHelpAt(home).status, 0);
    assert.deepEqual(listing(join(home, 'compile-cache')), first, 'the second run reads them and writes nothing new');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a foreign-writable or unusable cache folder falls back to uncached and the command still succeeds [C7]', () => {
  const home = privateFixtureFiles('pullboard-compile-cache-').root;
  try {
    mkdirSync(join(home, 'compile-cache'));
    chmodSync(join(home, 'compile-cache'), 0o777);
    const open = runHelpAt(home);
    assert.equal(open.status, 0);
    assert.deepEqual(readdirSync(join(home, 'compile-cache')), [], 'a folder others can write is not used');
    const blocked = join(home, 'blocked');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'compile-cache'), 'not a folder');
    assert.equal(runHelpAt(blocked).status, 0, 'a cache path that cannot be a folder is skipped');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
