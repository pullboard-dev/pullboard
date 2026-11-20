/** @pullboard-test-input test-tree */
/** @pullboard-world-pin walks the shipped source tree's import statements to prove no read command reaches an engine leaf. */
/**
 * Every command loads the state engines through one lazy door: list and show reach no engine leaf module, so adding an engine
 * file leaves the modules they load unchanged [C7].
 * Why a static walk: the modules a command loads are the ones its import statements reach, so no process is launched.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  resolve,
} from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../..');
const LEAVES = resolve(REPO, 'packages/state/src/logic/engines');
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu;

/** Every module a command file reaches through static import and re-export statements. */
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

test('gate.io-engine-lazy-door.list-and-show-reach-no-engine: clause 1: list and show reach no engine leaf, so a new engine file adds no module to either [C7]', () => {
  const leaves = readdirSync(LEAVES).filter(name => /^[\w-]+-engine\.js$/u.test(name));
  assert.ok(leaves.length >= 190, `found ${leaves.length} engine leaves`);
  for (const command of ['list', 'show']) {
    const modules = closure(`apps/cli/src/io/commands/${command}.js`);
    assert.ok(modules.length > 100, `${command} walked ${modules.length} modules`);
    assert.deepEqual(modules.filter(file => file.startsWith(`${LEAVES}/`)), [], `${command} loads an engine leaf`);
  }
});
