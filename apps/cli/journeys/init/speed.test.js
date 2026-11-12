// pullboard: browser
/** @pullboard-test-gui */
/** A real large board switches tabs inside the person's 100 ms interaction bar [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateStressBoard,
  removeStressBoard,
} from '../../tests/fixtures/cockpit/perf/generate.mjs';
import { measureTabSpeed } from '../../tests/fixtures/cockpit/perf/speed.mjs';

test('first and repeated tab clicks paint in under 100 ms on the real large board [N26]', { timeout: 300000 }, async t => {
  const board = generateStressBoard({ seed: 'tab-speed-1600', size: 1600, agents: 1150, shouts: 40000 });
  try {
    assert.equal(board.agentCount, 1150);
    assert.equal(board.shoutCount, 40000);
    const report = await measureTabSpeed(board);
    t.diagnostic(JSON.stringify({ population: { items: board.size, agents: board.agentCount, shouts: board.shoutCount }, ...report }));
    assert.equal(report.items, 1600);
    assert.equal(report.actions.length, 10);
    assert.ok(report.parse.length > 0, 'actual state body bytes and JSON parse time are observed');
    assert.ok(report.fetch.length > 0, 'actual browser fetch time is observed');
    assert.ok(report.render.length >= 10, 'every click retains its real render duration');
    assert.equal(report.isolation.length, 5);
    for (const sample of report.isolation) {
      assert.deepEqual(sample.hiddenMutations, [], `${sample.tab} does not rebuild another tab's data`);
      assert.equal(sample.ready, true, `${sample.tab} isolation control reaches its real content`);
    }
    for (const sample of report.actions) {
      assert.equal(sample.ready, true, `${sample.tab} paints its actual content after the click`);
      assert.ok(Number.isFinite(sample.end), `${sample.tab} has a real painted timestamp`);
      assert.ok(sample.end - sample.start < 100,
        `${sample.tab} ${sample.repeat ? 'repeat' : 'first'} click painted in ${sample.end - sample.start} ms (bar <100 ms)`);
    }
  } finally { removeStressBoard(board); }
});
