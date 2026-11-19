/** @pullboard-test-input source-cell packages/sync */
/** Sync reaches landing through its light door, never the landing barrel [C7,#10129]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { requirePreparedComputedConflict as fromBarrel } from '../../../landing/index.js';
import { requirePreparedComputedConflict as fromDoor } from '../../../landing/light.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const BARREL = resolve(import.meta.dirname, '..', '..', '..', 'landing', 'index.js');
const SPECIFIER = /^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gmu;

/** Every .js file under a folder. */
function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

test('sync.landing-door.no-barrel-import: clause 1: no import specifier in packages/sync/src resolves to the landing barrel file [C7,#10129]', () => {
  const main = join(SRC, 'io', 'main.js');
  assert.ok(jsFiles(SRC).includes(main));
  const resolved = [];
  for (const file of jsFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith('.')) resolved.push({ file, path: resolve(dirname(file), specifier) });
    }
  }
  assert.ok(resolved.some(({ file, path }) => file === main && path.endsWith(join('landing', 'light.js'))), 'main.js reads the light door');
  assert.deepEqual(resolved.filter(({ path }) => path === BARREL), []);
});

test('sync.landing-door.same-function: clause 2: requirePreparedComputedConflict from the light door is strictly equal to the barrel\'s [C7,#10129]', () => {
  assert.equal(typeof fromDoor, 'function');
  assert.equal(fromDoor, fromBarrel);
});
