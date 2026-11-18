/** @pullboard-test-input source-cell packages/gate */
/** The gate coordinator release module reaches stats through its light door, so loading it pulls in no stats shell [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as barrel from '../../stats/index.js';

const RELEASE = resolve(import.meta.dirname, '../src/io/coordinator/release.js');
const BARREL = resolve(import.meta.dirname, '../../stats/index.js');
const NAMES = ['previousCoordinatorMilestone', 'coordinatorActions', 'coordinatorActionRise'];
const IMPORT = /^\s*import\s*\{\s*(\w+)\s*\}\s*from\s*'([^']+)'/gmu;

/** Every named import of one binding in release.js, as { name, file } with the file its specifier resolves to. */
function releaseImports() {
  return [...readFileSync(RELEASE, 'utf8').matchAll(IMPORT)].map(match => ({ name: match[1], file: resolve(dirname(RELEASE), match[2]) }));
}

test('gate.coordinator-stats-door.release-skips-the-barrel: clause 1: no import specifier in coordinator/release.js resolves to the stats package barrel file [C7]', () => {
  const imports = releaseImports();
  assert.ok(NAMES.every(name => imports.some(entry => entry.name === name)), 'release.js imports the three coordinator names');
  assert.deepEqual(imports.filter(entry => entry.file === BARREL).map(entry => entry.name), [], 'no stats import goes through the barrel');
});

test('gate.coordinator-stats-door.release-names-match-the-barrel: clause 2: the three coordinator names release.js takes are strictly equal to the barrel\'s [C7]', async () => {
  for (const name of NAMES) {
    const taken = releaseImports().find(entry => entry.name === name);
    assert.ok(taken, `release.js imports ${name}`);
    const module = await import(taken.file);
    assert.equal(typeof module[name], 'function', `${name} is a function at its door`);
    assert.strictEqual(module[name], barrel[name], `${name} is the barrel's binding`);
  }
});
