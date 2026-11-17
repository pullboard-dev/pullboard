/** The thin pre-commit and commit-msg hook processes load at least 25 percent fewer modules than the whole hook graph they loaded before [C7,#8841]. @pullboard-test-input source-cell apps/cli packages */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const APP = resolve(import.meta.dirname, '../../../..');

/** Modules the thin entry's graph held before the hook checks were split by hook: one graph served every hook (counted at main, 797). */
const BEFORE = 797;

/** The most modules the pre-commit and commit-msg processes may load: 25 percent under the count before. */
const MOST = Math.floor(BEFORE * 0.75);

/** The static import graph from one module: every relative file the module imports or re-exports, followed to their imports in turn. */
function graph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^'"`;]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gmu)) queue.push(resolve(dirname(file), match[1] ?? match[2]));
  }
  return seen;
}

/** The modules one hook process loads: the thin entry's graph plus the one module that hook's checks live in. */
function loadedBy(hook) {
  return new Set([...graph(resolve(APP, 'src/io/hook/thin.js')), ...graph(resolve(APP, `src/io/hook/${hook}.js`))]);
}

for (const hook of ['pre-commit', 'commit-msg']) {
  test(`clause 2: the ${hook} process loads at least 25 percent fewer modules than before the split [C7,#8841]`, t => {
    const loaded = loadedBy(hook).size;
    t.diagnostic(`${hook} loads ${loaded} modules; before ${BEFORE}; at most ${MOST}`);
    assert.ok(loaded > 0, 'the graph walk found the hook modules');
    assert.ok(loaded <= MOST, `${hook} loads ${loaded} modules; at most ${MOST} (25 percent under ${BEFORE})`);
  });
}

test('clause 1: the thin entry alone no longer reaches the checks of any one hook [C7,#8841]', () => {
  const thin = graph(resolve(APP, 'src/io/hook/thin.js'));
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) assert.ok(!thin.has(resolve(APP, `src/io/hook/${hook}.js`)), `${hook}.js loads only for its own hook`);
});
