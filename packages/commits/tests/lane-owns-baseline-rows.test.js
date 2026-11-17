/** A lane renames, adds and lowers the ceiling rows of its own test files and never raises one [L3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outOfLane } from '../../seats/index.js';
import { CEILING_ROW_TABLES } from '../../gate/heavy.js';
import { STATIC_CHECKS } from '../../gate/heavy.js';
import { baselineRowChange } from '../light.js';

const config = { shared: [], lanes: { core: { owns: ['test/'] }, view: { owns: ['test/cockpit/'] } } };
const TABLES = ['packages/gate/data/tests/test-fixtures.json', 'packages/gate/data/baselines/test-waits-baseline.json'];
const blob = rows => ({ mode: '100644', bytes: Buffer.from(JSON.stringify(rows)) });

/** Judge one change to a baseline as the given lane's seat. */
function judge(lane, table, before, after) {
  return baselineRowChange(table, { before: () => blob(before), after: () => blob(after),
    ownsFile: file => !outOfLane(config, lane, [file]).length });
}

test('commits.lane-owns-baseline-rows.clause-1-a-view-split-moves-its-baseline: clause 1: a view split moves its baseline rows to the new files without raising their sum, in both baselines [L3,C7]', () => {
  for (const table of TABLES) {
    const base = { 'test/a.test.js': { sleep: 1 }, 'test/cockpit/roadmap.test.js': { sleep: 4, poll: 2 } };
    const split = { 'test/a.test.js': { sleep: 1 }, 'test/cockpit/roadmap-a.test.js': { sleep: 2, poll: 1 }, 'test/cockpit/roadmap-b.test.js': { sleep: 2, poll: 1 } };
    assert.equal(judge('view', table, base, split).allowed, true, table);
    const lowered = { ...split, 'test/cockpit/roadmap-b.test.js': { sleep: 1 } };
    assert.equal(judge('view', table, base, lowered).allowed, true, 'lowering a row is allowed');
  }
});

test('commits.lane-owns-baseline-rows.clause-2-a-raised-row-new-rows-beyond: clause 2: a raised row, new rows beyond what the change freed, or a row outside the lane is refused [L3,C7]', () => {
  const table = TABLES[0];
  const base = { 'test/a.test.js': { sleep: 1 }, 'test/cockpit/roadmap.test.js': { sleep: 4 } };
  const raised = judge('view', table, base, { ...base, 'test/cockpit/roadmap.test.js': { sleep: 5 } });
  assert.equal(raised.allowed, false);
  assert.match(raised.problem, /roadmap\.test\.js sleep would rise/u);
  const grown = judge('view', table, base, { ...base, 'test/cockpit/roadmap.test.js': { sleep: 3 }, 'test/cockpit/new.test.js': { sleep: 2 } });
  assert.equal(grown.allowed, false);
  assert.match(grown.problem, /total 2, more than the 1/u);
  const foreign = judge('view', table, base, { ...base, 'test/a.test.js': { sleep: 0 } });
  assert.equal(foreign.allowed, false);
  assert.match(foreign.problem, /test\/a\.test\.js is outside this lane/u);
  assert.equal(judge('core', table, base, { ...base, 'test/a.test.js': { sleep: 0 } }).allowed, true, 'the owning lane may lower its own row');
  assert.equal(baselineRowChange('packages/other.json', { before: () => null, after: () => null, ownsFile: () => true }).allowed, false);
});

/** The cells-edges ceilings: the gate table whose rows nest under files with more than one rule. */
const EDGES = Object.keys(CEILING_ROW_TABLES).find(table => CEILING_ROW_TABLES[table].files && !CEILING_ROW_TABLES[table].bare);

/** Each gate-owned ceiling table as a test document: its rows wrapped in the table's own shape. */
const CEILING_TABLES = Object.fromEntries(Object.entries(CEILING_ROW_TABLES).map(([table, shape]) => [table, {
  rule: shape.bare ? 'count' : 'cells',
  wrap: rows => (!shape.files ? rows : shape.bare
    ? { version: 1, total: 10, files: Object.fromEntries(Object.entries(rows).map(([file, row]) => [file, row.count])) }
    : { files: rows, cells: { a: 1 } }),
}]));

test('commits.lane-owns-baseline-rows.clause-1-a-source-row-moves-in-each-ceiling-table: clause 1: a source ceiling row moves to its own new file without a rise, in each per-file ceiling table [L3,C7,#10242]', () => {
  assert.equal(Object.keys(CEILING_TABLES).length, 5, 'load-bearing, store-homes, both adapter lints and cells-edges');
  assert.equal(baselineRowChange(Object.keys(CEILING_TABLES)[0], { before: () => null, after: () => null, ownsFile: () => true }).allowed, false, 'without the gate\'s tables a ceiling table is not a baseline');
  for (const [table, { wrap, rule }] of Object.entries(CEILING_TABLES)) {
    const base = wrap({ 'packages/a.js': { [rule]: 1 }, 'apps/view/src/io/serve.js': { [rule]: 4 } });
    const moved = wrap({ 'packages/a.js': { [rule]: 1 }, 'apps/view/src/io/serve.js': { [rule]: 2 }, 'apps/view/src/io/state.js': { [rule]: 2 } });
    const config = { shared: [], lanes: { core: { owns: ['packages/'] }, view: { owns: ['apps/view/'] } } };
    const judgeView = (before, after) => baselineRowChange(table, { before: () => blob(before), after: () => blob(after), ownsFile: file => !outOfLane(config, 'view', [file]).length, tables: CEILING_ROW_TABLES });
    assert.equal(judgeView(base, moved).allowed, true, table);
  }
});

test('commits.lane-owns-baseline-rows.clause-2-a-rise-beyond-the-freed-rows-is-refused-in-each-ceiling-table: clause 2: in each ceiling table a raised row, new rows beyond what was freed, a foreign row, or a rise outside the file rows is refused [L3,C7,#10242]', () => {
  for (const [table, { wrap, rule }] of Object.entries(CEILING_TABLES)) {
    const config = { shared: [], lanes: { core: { owns: ['packages/'] }, view: { owns: ['apps/view/'] } } };
    const judgeView = (before, after) => baselineRowChange(table, { before: () => blob(before), after: () => blob(after), ownsFile: file => !outOfLane(config, 'view', [file]).length, tables: CEILING_ROW_TABLES });
    const base = wrap({ 'packages/a.js': { [rule]: 1 }, 'apps/view/src/io/serve.js': { [rule]: 4 } });
    assert.equal(judgeView(base, wrap({ 'packages/a.js': { [rule]: 1 }, 'apps/view/src/io/serve.js': { [rule]: 5 } })).allowed, false, `${table} raise`);
    assert.equal(judgeView(base, wrap({ 'packages/a.js': { [rule]: 1 }, 'apps/view/src/io/serve.js': { [rule]: 3 }, 'apps/view/src/io/state.js': { [rule]: 2 } })).allowed, false, `${table} grown`);
    assert.equal(judgeView(base, wrap({ 'packages/a.js': { [rule]: 0 }, 'apps/view/src/io/serve.js': { [rule]: 4 } })).allowed, false, `${table} foreign`);
  }
  const clock = Object.keys(CEILING_ROW_TABLES).find(table => CEILING_ROW_TABLES[table].bare);
  const total = (n) => ({ version: 1, total: n, files: { 'apps/view/a.js': 1 } });
  const config = { shared: [], lanes: { view: { owns: ['apps/view/'] } } };
  assert.equal(baselineRowChange(clock, { before: () => blob(total(10)), after: () => blob(total(11)), ownsFile: file => !outOfLane(config, 'view', [file]).length, tables: CEILING_ROW_TABLES }).allowed, false, 'a total never rises');
  const edges = EDGES;
  const sections = (cells) => ({ files: { 'apps/view/a.js': { cells: 1, deep: 0 } }, cells });
  assert.equal(baselineRowChange(edges, { before: () => blob(sections({ a: 1 })), after: () => blob(sections({ a: 2 })), ownsFile: () => true, tables: CEILING_ROW_TABLES }).allowed, false, 'the other sections stay unchanged');
});

test('commits.lane-owns-baseline-rows.clause-3-the-pre-commit-judges-the-staged-ceiling-rows: clause 3: the pre-commit cells-edges check reads the staged ceiling rows, so a moved row is judged as moved [L3,C7,#10242]', () => {
  const check = STATIC_CHECKS.find(entry => entry.name === 'cells-edges');
  const file = 'apps/view/src/io/state.js';
  const source = "import { x } from '../../../../packages/config/index.js';\nexport const y = x;\n";
  const staged = JSON.stringify({ files: { [file]: { cells: 1, deep: 0 } }, cells: {}, packageApps: {} });
  const run = ceilingText => check.run({ root: '/nonexistent-root', sources: [{ file, source }],
    text: path => path === file ? source : path === EDGES ? ceilingText : '' });
  assert.deepEqual(run(staged), [], 'a row staged for the new file allows its one cell');
  const notStaged = JSON.stringify({ files: {}, cells: {}, packageApps: {} });
  assert.match(run(notStaged).join('\n'), /new cross-cell import of config exceeds the ratchet \(1 cells > 0\)/u, 'without the row the same import is refused');
});
