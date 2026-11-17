/** A lane renames, adds and lowers the ceiling rows of its own test files and never raises one [L3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outOfLane } from '../../seats/index.js';
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
