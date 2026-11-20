/** @pullboard-test-input test-tree */
/** @pullboard-world-pin walks the shipped source tree's import statements to prove the store light door reaches no config module. */
/**
 * The store light door loads without the config package: home.js reads the Git-sharing marker itself, so the 75 config
 * modules stay out of every light command's cold load [C7].
 * Why a static walk: the modules a door loads are the ones its import statements reach, so no process is launched.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  resolve,
} from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../..');
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;

/** Every module an entry file reaches through static import and re-export statements. */
function closure(entry) {
  const seen = new Set();
  const stack = [resolve(REPO, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) stack.push(resolve(dirname(file), match[1] ?? match[2]));
  }
  return [...seen];
}

test('store.io-light-door.the-static-import-closure-of-packages: clause 1: the static import closure of packages/store/light.js reaches no module of the config package [C7]', () => {
  const modules = closure('packages/store/light.js');
  assert.ok(modules.length > 100, `walked ${modules.length} modules`);
  assert.deepEqual(modules.filter(file => file.startsWith(`${REPO}/packages/config/`)), [], 'the store light door reaches a config module');
});

test("store.io-light-door.exports-relay-reads: clause 1: packages/store/light.js exports readReceivedBoardState and relayMachineDirectory, each the same function packages/store/index.js exports [C7]", async () => {
  const light = await import("../../light.js");
  const index = await import("../../index.js");
  for (const name of ["readReceivedBoardState", "relayMachineDirectory"]) {
    assert.equal(typeof light[name], "function", `${name} is exported by the light door`);
    assert.equal(light[name], index[name], `${name} is the same function the index exports`);
  }
});
