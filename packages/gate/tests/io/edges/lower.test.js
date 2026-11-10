/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** Earlier cells receive native quarantine authority from their opened board [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cellInventory } from '../../../../codemap/index.js';
import { mappedPath } from '../../../../codemap/index.js';
import { readPathMap } from '../../../../codemap/index.js';
import { commonJsIn } from '../../../index.js';
import { importsIn } from '../../../index.js';
import { readPlan } from '../../../../codemap/index.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

test('the actual store, sandbox and items graphs have no native quarantine imports [C7,CD64]', () => {
  const plan = readPlan(ROOT), map = readPathMap(ROOT);
  const provider = plan.cells.flatMap(cell => cell.paths).find(([from]) => from === 'src/quarantine.js');
  assert.ok(provider, 'quarantine retains its actual higher provider placement');
  const targets = new Set([...provider.slice(0, 2), mappedPath(map, provider[0])]);
  const { files, edges } = cellInventory(ROOT, { importsIn, commonJsIn });
  assert.ok([...targets].some(path => files.has(path)), 'the native provider still exists');
  for (const name of ['store', 'sandbox', 'items']) {
    const cell = plan.cells.find(row => row.name === name);
    assert.ok(cell, `the committed plan still identifies ${name}`);
    const sources = new Set(cell.paths.flatMap(([from, to]) => [from, to, mappedPath(map, from)]));
    const actual = [...edges].filter(([file]) => sources.has(file) || file.startsWith(`${cell.root}/`));
    assert.ok(actual.length > 0, `inspect live ${name} sources rather than a stale importer list`);
    const crossings = actual.flatMap(([from, rows]) => rows.filter(({ target }) => targets.has(target))
      .map(({ target }) => `${from} -> ${target}`));
    assert.deepEqual(crossings, [], `${name} uses actual composition-root quarantine capabilities`);
  }
});
