/** The generated tier table accepts a seat's own-lane rows and refuses any other lane's [L3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outOfLane } from '../packages/seats/index.js';
import { TIER_TABLE, tierRowChange } from '../src/tier-row-change.js';

const config = { shared: [], lanes: { core: { owns: ['test/'] }, view: { owns: ['test/cockpit/'] } } };
const row = file => ({ file, tier: 'T3', packages: ['.'] });
const blob = rows => ({ mode: '100644', bytes: Buffer.from(JSON.stringify({ version: 1, files: rows })) });

/** Judge one change to the table as the given lane's seat. */
function judge(lane, before, after) {
  return tierRowChange(TIER_TABLE, { before: () => blob(before), after: () => blob(after),
    ownsFile: file => !outOfLane(config, lane, [file]).length });
}

test('clause 1: a seat commits a tier table change whose rows all name its own lane, and a foreign row is refused [L3,C7]', () => {
  const base = [row('test/a.test.js'), row('test/cockpit/b.test.js')];
  assert.equal(judge('view', base, [...base, row('test/cockpit/c.test.js')]).allowed, true);
  assert.equal(judge('view', base, [...base, row('test/cockpit/c.test.js'), row('test/d.test.js')]).allowed, false);
  assert.equal(judge('view', base, [row('test/a.test.js'), row('test/cockpit/b.test.js')].map(r => ({ ...r, tier: 'T1' }))).allowed, false);
  assert.equal(tierRowChange('packages/other.json', { before: () => null, after: () => null, ownsFile: () => true }).allowed, false);
});

test('clause 2: a view seat adds test/cockpit/new.test.js with its row but may not edit a core test row [L3,C7]', () => {
  const base = [row('test/a.test.js')];
  assert.equal(judge('view', base, [...base, row('test/cockpit/new.test.js')]).allowed, true);
  const edited = [{ ...row('test/a.test.js'), tier: 'T1' }];
  const refused = judge('view', base, edited);
  assert.equal(refused.allowed, false);
  assert.match(refused.problem, /test\/a\.test\.js/);
  assert.equal(judge('core', base, edited).allowed, true);
});
