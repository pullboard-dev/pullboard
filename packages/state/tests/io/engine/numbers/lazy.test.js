/** @pullboard-test-input source-cell packages/state */
/** @pullboard-test-loads packages/state/src/logic/engines/*-engine.js */
/**
 * The state doors read each engine leaf's number from the leaf's text instead of loading the leaf, and every number
 * they give equals what loading the leaf gives; the engine folder check still refuses any other declaration [C7].
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as light from '../../../../light.js';
import * as door from '../../../../index.js';
import { engineNumber } from '../../../../src/logic/engine/number.js';
import { ENGINE_NUMBERS } from '../../../../src/logic/engine/table.js';
import { engineFolderViolations } from '../../../../src/io/engine/folder.js';
import { ENGINE_REGISTRY } from '../../../../src/io/engine/metadata.js';
import { readEngineLeaves } from '../../../../src/io/engine/numbers.js';

const ENGINES = new URL('../../../../src/logic/engines/', import.meta.url);

/** Every engine number the leaves give when each is loaded as a module: the eager registry. */
async function eagerNumbers() {
  const numbers = new Map();
  for (const file of readdirSync(ENGINES).filter(name => /^[\w-]+-engine\.js$/u.test(name))) {
    for (const [name, value] of Object.entries(await import(new URL(file, ENGINES).href))) {
      if (name.endsWith('_ENGINE') && typeof value === 'number') numbers.set(name, value);
    }
  }
  return numbers;
}

test('state.io-engine-numbers-lazy.clause-1-every-engine-number-read-from: clause 1: every engine number read from leaf text equals the number loading its leaf gives [C7]', async () => {
  const eager = await eagerNumbers();
  assert.ok(eager.size >= 190, `found ${eager.size} engine leaves`);
  for (const [name, value] of eager) assert.equal(engineNumber(name), value, `${name} keeps engine ${value}`);
  // A branch's unlanded leaf reads as the next engine and has no table row until its landing merge numbers it (#1101).
  const landed = readEngineLeaves(fileURLToPath(ENGINES)).filter(leaf => leaf.number !== null);
  const landedEager = [...eager].filter(([name]) => landed.some(leaf => leaf.name === name));
  assert.deepEqual(Object.keys(ENGINE_NUMBERS).sort(), landedEager.map(([name]) => name).sort(), 'the generated table lists exactly the landed leaves');
  assert.equal(engineNumber('NO_SUCH_ENGINE'), Math.max(...landedEager.map(([, value]) => value)) + 1, 'a name with no landed leaf reads as the next engine');
});

test('state.io-engine-numbers-lazy.clause-1-the-light-and-full-state-doors: clause 1: the light and full state doors give each leaf engine exactly as the leaf declares it [C7]', async () => {
  const eager = await eagerNumbers();
  let read = 0;
  for (const exports of [light, door]) {
    for (const [name, value] of Object.entries(exports)) {
      if (!eager.has(name)) continue;
      assert.equal(value, eager.get(name), `${name} keeps engine ${eager.get(name)}`);
      read += 1;
    }
  }
  assert.ok(read >= 230, `the doors forward ${read} leaf engines`);
  assert.equal(light.ENGINE_VERSION, Math.max(...Object.values(ENGINE_REGISTRY)), 'the light door keeps the registry engine version');
});

test('state.io-engine-numbers-lazy.clause-1-the-engine-folder-check-accepts: clause 1: the engine folder check accepts a state door reading its own leaf by name and refuses any other number [C7]', () => {
  const leaf = { file: 'packages/state/src/logic/engines/sample-engine.js', source: 'export const SAMPLE_ENGINE = 3;\n' };
  const forwards = source => engineFolderViolations([leaf, { file: 'packages/state/light.js', source }]).map(row => row.line);
  assert.deepEqual(forwards("export const SAMPLE_ENGINE = engineNumber('SAMPLE_ENGINE');\n"), []);
  assert.deepEqual(forwards("export const OTHER_ENGINE = engineNumber('OTHER_ENGINE');\n"), [1], 'a name no leaf declares is a declaration');
  assert.deepEqual(forwards("export const OTHER_ENGINE = engineNumber('SAMPLE_ENGINE');\n"), [1], 'a renamed number is a declaration');
  assert.deepEqual(forwards('export const SAMPLE_ENGINE = 3;\n'), [1], 'a copied number is a declaration');
  const outside = engineFolderViolations([leaf, { file: 'packages/other/x.js', source: "export const SAMPLE_ENGINE = engineNumber('SAMPLE_ENGINE');\n" }]);
  assert.deepEqual(outside.map(row => row.file), ['packages/other/x.js'], 'only the state cell reads leaf numbers by name');
});
