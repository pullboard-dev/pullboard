/** @pullboard-test-input source-cell packages/gate packages/codemap */
/** @pullboard-world-pin reads the committed rename chain, the gate sources and the front door to prove the preload.js move. */
/** The gate preload.js module sits in the shell cell, with its importers repointed [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const GATE = new URL('../../', import.meta.url);
const PLAN = new URL('../../../codemap/data/plan/', import.meta.url);
const OLD = 'packages/gate/src/logic/preload.js';
const NEW = 'packages/gate/src/io/preload.js';
const read = (base, path) => readFileSync(new URL(path, base), 'utf8');

test('clause 1: gate preload.js sits in the shell cell in the cells plan with importers repointed [C7]', () => {
  assert.ok(existsSync(new URL('src/io/preload.js', GATE)));
  assert.ok(!existsSync(new URL('src/logic/preload.js', GATE)));
  const freeze = JSON.parse(read(PLAN, 'path-map/freeze.json'));
  assert.equal(freeze['packages/gate/src/core/preload-policy.js'], NEW);
  assert.ok(!Object.values(freeze).includes(OLD));
  assert.ok(read(PLAN, 'renames.tsv').includes(`packages/gate/src/core/preload-policy.js\t${NEW}\n`));
  assert.ok(!read(PLAN, 'renames.tsv').includes(OLD));
  assert.match(read(GATE, 'index.js'), /from '\.\/src\/io\/preload\.js'/u);
  assert.match(read(GATE, 'src/io/test/isolation.js'), /from '\.\.\/preload\.js'/u);
  assert.match(read(GATE, 'src/io/test/action/memo.js'), /from '\.\.\/\.\.\/preload\.js'/u);
  assert.match(read(GATE, 'src/io/test/tier/cache.js'), /from '\.\.\/\.\.\/preload\.js'/u);
  const ceilings = JSON.parse(read(GATE, 'data/ceilings/no-runtime-assumptions.json'));
  assert.ok(JSON.stringify(ceilings).includes(NEW));
  assert.ok(!JSON.stringify(ceilings).includes(OLD));
});
