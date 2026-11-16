/** @pullboard-test-input source-cell apps/cli */
/** No tab-speed row is raised above its value on main, and the goal stays 100 ms: a ceiling pinned as data, lowered only by editing it down [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TAB_SPEED_GOAL_MS,
  TAB_SPEED_ROWS,
} from '../../../tests/fixtures/cockpit/perf/tab-speed-rows.mjs';

/** The value of every row on main today; lower a number here when its row drops, never raise one. */
const CEILING = {
  spec: { first: 1400, repeat: 600 },
  doctrine: { first: 450, repeat: 380 },
  items: { first: 560, repeat: 1000 },
  roadmap: { first: 1900, repeat: 260 },
  dashboard: { hang: true },
};

test('clause 1: every TAB_SPEED_ROWS number is at most its value on main and the goal is 100 ms [C7]', () => {
  assert.equal(TAB_SPEED_GOAL_MS, 100);
  for (const [tab, row] of Object.entries(TAB_SPEED_ROWS)) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number') assert.ok(value <= CEILING[tab][key], `${tab} ${key} is ${value} ms, above its ceiling of ${CEILING[tab][key]} ms`);
    }
  }
});

test('clause 2: a row may be absent or lower, never higher, and no new tab row appears [C7]', () => {
  for (const [tab, row] of Object.entries(TAB_SPEED_ROWS)) {
    assert.ok(Object.hasOwn(CEILING, tab), `${tab} is a new tab row`);
    for (const key of Object.keys(row)) assert.ok(Object.hasOwn(CEILING[tab], key), `${tab} gained the key ${key}`);
    if (row.hang) assert.equal(CEILING[tab].hang, true, `${tab} hang row has no ceiling hang`);
  }
});
