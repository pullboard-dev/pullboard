/** @pullboard-test-input source-cell packages/state */
/** @pullboard-world-pin: clause 1 reads the committed constants door and its imports to prove which modules it loads. */
/** The engine-number constants door carries every light-door engine number without loading the machine declaration or the defaults [C7,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as door from '../../../src/logic/engine/constants.js';
import * as light from '../../../light.js';

const doorPath = fileURLToPath(new URL('../../../src/logic/engine/constants.js', import.meta.url));

/** Every file the door reaches through relative imports and re-exports. */
function closure(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) stack.push(resolve(dirname(file), match[1]));
  }
  return seen;
}

test('state.logic-engine-constants.door-matches-light: the door exports every *_ENGINE number the light door exports plus ENGINE_VERSION, each equal [C7,H16]', () => {
  const names = Object.keys(light).filter(name => name.endsWith('_ENGINE') || name === 'ENGINE_VERSION');
  assert.ok(names.length > 100);
  assert.ok(names.includes('ENGINE_VERSION'));
  for (const name of names) assert.equal(door[name], light[name], name);
  assert.deepEqual(Object.keys(door).sort(), names.sort());
});

test('state.logic-engine-constants.door-stays-small: the door loads neither the machine declaration nor the defaults [C7,H16]', () => {
  const files = [...closure(doorPath)].map(file => file.replace(/^.*packages\/state\//, ''));
  assert.ok(files.includes('src/logic/engine/number.js'));
  assert.ok(!files.includes('src/logic/machine/declaration.js'));
  assert.ok(!files.includes('src/logic/defaults.js'));
});

test('state.logic-engine-constants.light-keeps-machine: the light door still exports MACHINE beside the engine numbers [C7,H16]', () => {
  assert.equal(typeof light.MACHINE, 'object');
  assert.equal(light.ENGINE_VERSION, door.ENGINE_VERSION);
});
