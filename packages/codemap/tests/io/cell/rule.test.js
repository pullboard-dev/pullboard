/** The declared cell rule is read from its own data file, and the shim cutter takes its allowed edges from it, not from the plan [C7,#2467]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutShims } from '../../../src/io/shims.js';
import { readCellRule } from '../../../light.js';
import { CELL_RULE_FILE } from '../../../index.js';
import { readCellRule as readCellRuleSync } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

/** A one-shim tree: packages/a imports a root shim that forwards to packages/b, and the rule declares the given edges. */
function tree(allowedEdges) {
  const files = privateFixtureFiles('cell-rule-shims-');
  files.write('package.json', '{"name":"fixture"}\n');
  files.write('pullboard.json', '{"lanes":{"core":{"owns":["src/","packages/"]}}}\n');
  files.write('packages/b/index.js', 'export const value = 1;\n');
  files.write('src/b-shim.js', "export { value } from '../packages/b/index.js';\n");
  files.write('packages/a/src/use.js', "import { value } from '../../../src/b-shim.js';\nexport const used = value;\n");
  files.write('packages/codemap/data/ceilings/allowed-edges.json', `${JSON.stringify({ allowedEdges, upwardEdgesGrandfathered: [], cellOrder: [] })}\n`);
  runFixtureSetupGit(['init', '-q'], { cwd: files.root });
  runFixtureSetupGit(['add', '-A'], { cwd: files.root });
  return files.root;
}

test('codemap.io-cell-rule.reads-declared-edges: clause 1: the reader returns the declared allowed edges, the grandfathered upward edges and the cell order, lowest first [C7,#2467]', async () => {
  const rule = await readCellRule();
  assert.ok(rule.allowedEdges.length > 100, 'the declared edge set is the plan\'s whole list');
  assert.ok(rule.allowedEdges.every(edge => /^[^>]+->[^>]+$/u.test(edge)), 'every edge reads from->to');
  assert.ok(rule.allowedEdges.includes('codemap->fs'));
  assert.deepEqual(rule.upwardEdgesGrandfathered.slice(0, 2), ['apps/cli->apps/relay', 'apps/cli->search']);
  assert.deepEqual(rule.cellOrder.slice(0, 3), ['kernel', 'fs', 'clock']);
  assert.equal(new Set(rule.cellOrder).size, rule.cellOrder.length, 'a cell is ordered once');
});

test('codemap.io-cell-rule.shims-use-declared-edges: clause 2: the shim cutter repoints an importer across a cell edge the rule declares, and holds it when the rule does not, with no plan folder in the tree [C7,#2467]', () => {
  const declared = cutShims(tree(['a->b']), { write: false });
  assert.deepEqual(declared.cut, ['src/b-shim.js']);
  assert.deepEqual(declared.files, ['packages/a/src/use.js']);
  const undeclared = cutShims(tree([]), { write: false });
  assert.deepEqual(undeclared.cut, []);
  assert.ok(undeclared.kept.some(([shim, reasons]) => shim === 'src/b-shim.js' && reasons.some(reason => reason.includes('cross-cell imports'))));
});

test('codemap.io-cell-rule.front-door-reads-sync: clause 1: the front door exports the synchronous reader and the rule file name, and it sees the same edges, grandfathered edges and cell order as the light door [C7,#11676]', async () => {
  const sync = readCellRuleSync();
  assert.equal(CELL_RULE_FILE, 'packages/codemap/data/ceilings/allowed-edges.json');
  const light = await readCellRule();
  assert.ok(sync.allowedEdges.length > 100, 'the declared edge set is the plan\'s whole list');
  assert.deepEqual(sync.allowedEdges, light.allowedEdges);
  assert.deepEqual(sync.upwardEdgesGrandfathered, light.upwardEdgesGrandfathered);
  assert.deepEqual(sync.cellOrder, light.cellOrder);
});
