/** @pullboard-test-input source-cell codemap */
/** The cells cache directory and publish helpers live in cache-files.js, not in the inventory cache [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as files from '../../../src/io/cells/cache-files.js';

const CELLS = fileURLToPath(new URL('../../../src/io/cells/', import.meta.url));

/** Every .js file under one folder, as absolute paths. */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
}

test('clause 1: cache-files.js exports both helpers and cache.js defines neither, no file imports them from cache.js [C7]', () => {
  assert.equal(typeof files.cellsCacheDirectory, 'function');
  assert.equal(typeof files.publishCacheEntry, 'function');
  const cache = readFileSync(join(CELLS, 'scripts/cache.js'), 'utf8');
  assert.doesNotMatch(cache, /function\s+(cellsCacheDirectory|publishCacheEntry)\b/u);
  for (const file of sources(CELLS)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n').filter(entry => /^import\b/u.test(entry) && /\/(scripts\/)?cache\.js'/u.test(entry))) {
      assert.doesNotMatch(line, /\b(cellsCacheDirectory|publishCacheEntry)\b/u, `${file} imports a moved helper from cache.js`);
    }
  }
});
