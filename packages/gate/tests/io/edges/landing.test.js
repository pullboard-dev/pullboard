/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** Landing reads native quarantine authority through explicit composition ports [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cellInventory } from '../../../../codemap/index.js';
import { mappedPath } from '../../../../codemap/index.js';
import { readPathMap } from '../../../../codemap/index.js';
import { commonJsIn } from '../../../heavy.js';
import { importsIn } from '../../../heavy.js';
import { readPlan } from '../../../../codemap/index.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

test('gate.io-edges-landing.the-actual-landing-import-graph-has: the actual landing import graph has no edge into native quarantine [C7,CD64]', () => {
  const plan = readPlan(ROOT), map = readPathMap(ROOT);
  const landing = plan.cells.find(cell => cell.name === 'landing');
  assert.ok(landing, 'the real committed plan identifies landing');
  const provider = plan.cells.flatMap(cell => cell.paths).find(([from]) => from === 'src/quarantine.js');
  assert.ok(provider, 'quarantine retains its actual provider placement');
  const targets = new Set([...provider.slice(0, 2), mappedPath(map, provider[0])]);
  const sources = new Set(landing.paths.flatMap(([from, to]) => [from, to, mappedPath(map, from)]));
  const { files, edges } = cellInventory(ROOT, { importsIn, commonJsIn });
  assert.ok([...targets].some(path => files.has(path)), 'the native provider still exists');
  const actual = [...edges].filter(([file]) => sources.has(file) || file.startsWith(`${landing.root}/`));
  assert.ok(actual.length > 0, 'inspect the live landing sources rather than a stale list of eight importers');
  const crossings = actual.flatMap(([from, rows]) => rows.filter(({ target }) => targets.has(target))
    .map(({ target }) => `${from} -> ${target}`));
  assert.deepEqual(crossings, [], 'pass quarantine authority from actual higher composition roots');
});
