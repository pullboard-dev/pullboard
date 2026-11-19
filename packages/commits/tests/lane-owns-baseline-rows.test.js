/** A lane renames, adds and lowers the ceiling rows of its own test files and never raises one [L3,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { outOfLane } from '../../seats/index.js';
import { baselineRowChange } from '../light.js';
import { privateFixtureFiles } from '../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';

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

/**
 * Stand-ins for the tables the gate cell hands the hook (its CEILING_ROW_TABLES), one of each row shape: plain
 * `{file: {rule: n}}` rows (load-bearing, store-homes), bare counts under `files` (both adapter lints), and rule rows
 * under `files` beside other sections (cells-edges). The gate's own test proves the real list.
 */
const CEILING_ROW_TABLES = { 'ceilings/rows.json': {}, 'ceilings/bare.json': { files: true, bare: true }, 'ceilings/nested.json': { files: true } };

/** The nested stand-in: rows under files with sections beside them. */
const EDGES = 'ceilings/nested.json';

/** Each gate-owned ceiling table as a test document: its rows wrapped in the table's own shape. */
const CEILING_TABLES = Object.fromEntries(Object.entries(CEILING_ROW_TABLES).map(([table, shape]) => [table, {
  rule: shape.bare ? 'count' : 'cells',
  wrap: rows => (!shape.files ? rows : shape.bare
    ? { version: 1, total: 10, files: Object.fromEntries(Object.entries(rows).map(([file, row]) => [file, row.count])) }
    : { files: rows, cells: { a: 1 } }),
}]));

test('commits.lane-owns-baseline-rows.clause-1-a-source-row-moves-in-each-ceiling-table: clause 1: a source ceiling row moves to its own new file without a rise, in each per-file ceiling table [L3,C7,#10242]', () => {
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

/** A bare ceiling table as written to disk: one row per line, so a slice that deletes a row edits only that line. */
const bareTable = (rows, total) => `${JSON.stringify({ version: 1, ...(total === undefined ? {} : { total }), files: rows }, null, 2)}\n`;
const BARE = Object.keys(CEILING_ROW_TABLES).find(table => CEILING_ROW_TABLES[table].bare);

test('commits.lane-owns-baseline-rows.clause-3-a-bare-table-without-a-total-sums-its-rows: clause 3: a bare ceiling table that stores no total is judged by the sum of its file rows, so a raised row or an unfreed new row is still refused [L3,C7,#11936]', () => {
  const config = { shared: [], lanes: { view: { owns: ['apps/view/'] } } };
  const judgeView = (before, after) => baselineRowChange(BARE, { before: () => blob(before), after: () => blob(after), ownsFile: file => !outOfLane(config, 'view', [file]).length, tables: CEILING_ROW_TABLES });
  const base = { version: 1, files: { 'apps/view/a.js': 3, 'apps/view/b.js': 2 } };
  assert.equal(judgeView(base, { version: 1, files: { 'apps/view/a.js': 3 } }).allowed, true, 'a deleted row needs no total edit');
  assert.equal(judgeView(base, { version: 1, files: { 'apps/view/a.js': 1, 'apps/view/b.js': 2, 'apps/view/c.js': 2 } }).allowed, true, 'a split keeps the summed total');
  assert.match(judgeView(base, { version: 1, files: { 'apps/view/a.js': 4, 'apps/view/b.js': 2 } }).problem, /total would rise/u, 'a raised row raises the sum');
  assert.match(judgeView(base, { version: 1, files: { 'apps/view/a.js': 3, 'apps/view/b.js': 2, 'apps/view/c.js': 1 } }).problem, /total would rise/u, 'a new row that nothing freed raises the sum');
  const stored = { version: 1, total: 5, files: base.files };
  assert.equal(judgeView(stored, { version: 1, files: { 'apps/view/a.js': 3, 'apps/view/b.js': 1 } }).allowed, true, 'dropping a stored total compares its rows against it');
  assert.match(judgeView(stored, { version: 1, files: { 'apps/view/a.js': 3, 'apps/view/b.js': 2, 'apps/view/c.js': 1 } }).problem, /total would rise/u);
});

test('commits.lane-owns-baseline-rows.clause-4-two-slices-deleting-different-rows-merge-clean: clause 4: two slices that each delete a different row of a total-free bare table merge through git merge-file with no conflict, and the merged table passes against the base [L3,C7,#11936]', (t) => {
  const { root, write } = privateFixtureFiles('pullboard-ceiling-merge-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = { 'apps/view/a.js': 1, 'apps/view/b.js': 2, 'apps/view/c.js': 3, 'apps/view/d.js': 4, 'apps/view/e.js': 5 };
  const without = (file) => Object.fromEntries(Object.entries(rows).filter(([name]) => name !== file));
  const merge = (shape) => {
    for (const [name, text] of Object.entries(shape)) write(name, text);
    return runFixtureChild('git', ['merge-file', '-p', join(root, 'ours'), join(root, 'base'), join(root, 'theirs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  };
  const clean = merge({ base: bareTable(rows), ours: bareTable(without('apps/view/b.js')), theirs: bareTable(without('apps/view/d.js')) });
  assert.equal(clean.status, 0, 'no conflict');
  const merged = JSON.parse(clean.stdout);
  assert.deepEqual(merged, { version: 1, files: { 'apps/view/a.js': 1, 'apps/view/c.js': 3, 'apps/view/e.js': 5 } });
  const config = { shared: [], lanes: { view: { owns: ['apps/view/'] } } };
  assert.equal(baselineRowChange(BARE, { before: () => blob(JSON.parse(bareTable(rows))), after: () => blob(merged), ownsFile: file => !outOfLane(config, 'view', [file]).length, tables: CEILING_ROW_TABLES }).allowed, true);
  const total = (files) => bareTable(files, Object.values(files).reduce((sum, count) => sum + count, 0));
  assert.notEqual(merge({ base: total(rows), ours: total(without('apps/view/b.js')), theirs: total(without('apps/view/d.js')) }).status, 0, 'the same two slices conflict on a stored total');
});
