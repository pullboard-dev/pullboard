/** @pullboard-test-input source-cell apps/cli packages/codemap */
/** @pullboard-world-pin: clause 2 reads cells-submit-checks.js itself to prove which module it imports the cache from [C7,#9464]. */
/** apps/cli reaches the cells inventory cache through one door file; the tool-tree string imports stay as they are [C7,#9464]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as door from '../../src/io/cells/cache-door.js';
import * as codemap from '../../../../packages/codemap/index.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NAMES = ['inventoryCache', 'inventoryCodeDigest', 'inventoryPending', 'observationCache'];

test('clause 1: cache-door.js re-exports inventoryCache, observationCache, inventoryPending and inventoryCodeDigest and nothing else [C7,#9464]', () => {
  assert.deepEqual(Object.keys(door).sort(), NAMES);
  for (const name of NAMES) assert.equal(door[name], codemap[name], `${name} is the codemap door's own export`);
});

test('clause 2: cells-submit-checks.js imports the cache only from the door file, not from the codemap door [C7,#9464]', () => {
  const source = readFileSync(`${ROOT}apps/cli/src/io/cells-submit-checks.js`, 'utf8');
  const imports = [...source.matchAll(/^import \{ (\w+) \} from '([^']+)';$/gmu)];
  for (const name of NAMES) {
    const from = imports.filter(match => match[1] === name).map(match => match[2]);
    assert.ok(!from.some(path => path.endsWith('packages/codemap/index.js')), `${name} is not imported from the codemap door`);
  }
  for (const name of ['inventoryCache', 'observationCache', 'inventoryPending']) {
    assert.deepEqual(imports.filter(match => match[1] === name).map(match => match[2]), ['./cells/cache-door.js'], `${name} comes from the door file`);
  }
});

test('clause 2: the three tool-tree string entries keep their tool-tree import of cache.js, which a door file cannot serve [C7,#9464]', () => {
  for (const file of ['apps/cli/src/io/fixture-memo-warm.js', 'apps/cli/src/io/submit/gate.js', 'apps/cli/src/io/submit/remote.js']) {
    assert.match(readFileSync(`${ROOT}${file}`, 'utf8'), /import \* as cellsCache from '\.\/packages\/codemap\/src\/io\/cells\/scripts\/cache\.js';/u, `${file} keeps the tool-tree import`);
  }
});
