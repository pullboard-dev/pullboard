/** A split file whose imports the old file already held is not a ceiling rise; one more cell still is [L3,C7,#10359]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CEILING_ROW_TABLES } from '../../../heavy.js';
import { splitRowCovered } from '../../../src/io/ceilings/rows.js';
import { CELLS_EDGES_CEILINGS } from '../../../src/io/test/tier/selection.js';
import { CLOCK_CEILING_FILE } from '../../../src/io/adapter-lints/clock.js';
import { baselineRowChange } from '../../../../commits/light.js';

const OLD = 'apps/view/src/io/state.js';
const NEW = 'apps/view/src/io/state-more.js';
const imp = (cell, name) => `import { ${name} } from '../../../../packages/${cell}/index.js';\n`;
const blob = value => ({ mode: '100644', bytes: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });

/** Judge a staged split of OLD into NEW: sources by revision, and the rows before and after. */
function judge(table, { head, index, before, after }) {
  const sources = { HEAD: head, ':index': index };
  const read = (revision, path) => sources[revision][path] === undefined ? null : blob(sources[revision][path]);
  const shape = table === CELLS_EDGES_CEILINGS ? { ...CEILING_ROW_TABLES[table], splitCovered: splitRowCovered } : CEILING_ROW_TABLES[table];
  return baselineRowChange(table, { before: () => blob(before), after: () => blob(after), ownsFile: () => true, tables: { [table]: shape }, read });
}

const rows = files => ({ files, cells: {}, packageApps: {} });

test('gate.ceiling-split.covered: clause 1: a split whose new file imports a subset of the old file cells passes the cells-edges row check without a raise [L3,C7]', () => {
  const head = { [OLD]: imp('config', 'a') + imp('items', 'b') };
  const index = { [OLD]: imp('config', 'a') + imp('items', 'b') + '// less code\n', [NEW]: imp('config', 'a') };
  const verdict = judge(CELLS_EDGES_CEILINGS, { head, index,
    before: rows({ [OLD]: { cells: 2, deep: 0 } }), after: rows({ [OLD]: { cells: 2, deep: 0 }, [NEW]: { cells: 1, deep: 0 } }) });
  assert.deepEqual(verdict, { allowed: true, problem: null });
  assert.equal(splitRowCovered({ file: NEW, old: { [OLD]: {} }, next: { [OLD]: {}, [NEW]: {} }, read: (rev, path) => (rev === 'HEAD' ? head : index)[path] === undefined ? null : blob((rev === 'HEAD' ? head : index)[path]) }), true);
});

test('gate.ceiling-split.clock-rows: clause 1: an adapter-lint clock row moved with its code to the new file nets to zero and passes [L3,C7]', () => {
  const verdict = judge(CLOCK_CEILING_FILE, { head: {}, index: {},
    before: { files: { [OLD]: 3 } }, after: { files: { [OLD]: 1, [NEW]: 2 } } });
  assert.deepEqual(verdict, { allowed: true, problem: null });
});

test('gate.ceiling-split.new-cell: clause 2: a split whose new file adds a cell the old file did not import is still refused [L3,C7]', () => {
  const head = { [OLD]: imp('config', 'a') };
  const index = { [OLD]: imp('config', 'a'), [NEW]: imp('config', 'a') + imp('items', 'b') };
  const verdict = judge(CELLS_EDGES_CEILINGS, { head, index,
    before: rows({ [OLD]: { cells: 1, deep: 0 } }), after: rows({ [OLD]: { cells: 1, deep: 0 }, [NEW]: { cells: 2, deep: 0 } }) });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.problem, /new baseline rows for cells total 2, more than the 0/u);
  const grown = judge(CELLS_EDGES_CEILINGS, { head: { [OLD]: imp('config', 'a') }, index: { [OLD]: imp('config', 'a') + imp('items', 'b'), [NEW]: imp('config', 'a') },
    before: rows({ [OLD]: { cells: 1, deep: 0 } }), after: rows({ [OLD]: { cells: 1, deep: 0 }, [NEW]: { cells: 1, deep: 0 } }) });
  assert.equal(grown.allowed, false, 'an old file that gained a cell is not an origin');
});
