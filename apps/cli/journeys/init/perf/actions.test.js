// pullboard: browser
/** @pullboard-test-gui */
/** The real-Chrome performance harness measures every action on a 150-item stress board [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateStressBoard,
  removeStressBoard,
} from '../../../tests/fixtures/cockpit/perf/generate.mjs';
import { withPerfSlot } from '../../../tests/fixtures/cockpit/perf/run.mjs';

test("the perf harness measures every action on a stress board and its table lists each request's bytes [N26]", async (t) => {
  let first = null;
  let second = null;
  t.after(() => {
    if (!t.passed) {
      console.error(`Performance evidence retained at ${first?.workspace ?? 'fixture setup did not finish'}${second ? ` and ${second.workspace}` : ''}`);
      return;
    }
    if (second) removeStressBoard(second);
    if (first) removeStressBoard(first);
  });
  await withPerfSlot(async (run) => {
    const evidenceRoot = process.env.PULLBOARD_PERF_EVIDENCE_ROOT;
    first = generateStressBoard({ seed: 'named-perf-test', size: 150, ...(evidenceRoot ? { parent: evidenceRoot } : {}) });
    second = generateStressBoard({ seed: 'named-perf-test', size: 150, ...(evidenceRoot ? { parent: evidenceRoot } : {}) });

    assert.equal(first.digest, second.digest, 'the same seed and size produce the same board digest');
    assert.equal(Object.values(first.statusTotals).reduce((sum, count) => sum + count, 0), 150);
    assert.ok(Object.values(first.statusTotals).every((count) => count > 0), 'all five item states are represented');
    assert.equal(Object.values(first.laneTotals).reduce((sum, count) => sum + count, 0), 150);
    assert.ok(Object.values(first.laneTotals).every((count) => count > 0), 'all four measured lanes are represented');
    assert.ok(first.itemEvents > 150, 'the generated board contains long item histories');
    assert.ok(first.shoutCount > 0 && first.milestoneRows > 0 && first.specRows > 0, 'the generated board covers feeds, roadmap and spec data');
    assert.equal(first.specStatusTotals.draft, 1, 'one draft row is visible under the spec tab default filter');
    assert.equal(first.specStatusTotals.approved, first.specRows - 1, 'the remaining generated spec rows stay approved');
    assert.equal(Object.values(first.specStatusTotals).reduce((sum, count) => sum + count, 0), first.specRows,
      'the spec status distribution matches the generated row count');

    const report = await run({ board: first, runs: 1, idleMs: 30_000, liveEveryMs: 5_000 });
    t.diagnostic(JSON.stringify({ performanceReport: report }));
    const expected = ['firstLoad', 'tab:shouts', 'tab:spec', 'tab:doctrine', 'tab:activity', 'tab:roadmap', 'tab:items',
      'openSmallItem', 'openLongestHistoryItem', 'search', 'idleWithLiveWrites'];
    assert.deepEqual(report.actions.map((action) => action.name), expected);
    for (const action of report.actions) {
      assert.ok(Number.isFinite(action.medianMs) && Number.isFinite(action.worstMs), `${action.name} has a stable-paint duration`);
      assert.ok(action.samples.every((sample) => sample.stable === true), `${action.name} reached a stable visible target`);
      assert.ok(action.samples.every((sample) => sample.longTaskObserverStatus === 'available'), `${action.name} has Long Task observation available`);
      assert.ok(action.samples.every((sample) => Array.isArray(sample.longTasks)), `${action.name} reports its observed long-task entries`);
      assert.ok(action.samples.every((sample) => sample.longTasks.every((task) => Number.isFinite(task.durationMs) && task.durationMs >= 0)),
        `${action.name} reports finite observed long-task durations`);
      assert.ok(action.samples.every((sample) => Number.isFinite(sample.largestLongTaskMs)), `${action.name} has a numeric largest long task when observation is available`);
      assert.equal(action.requestBytesPerRun.length, 1, `${action.name} reports request bytes for the run`);
      assert.ok(Number.isSafeInteger(action.requestBytesPerRun[0]), `${action.name} reports encoded response bytes`);
      assert.ok(action.samples.every((sample) => Array.isArray(sample.requests)), `${action.name} reports individual local requests`);
    }
    const firstLoad = report.actions[0].samples[0];
    const successfulFirstLoadRequests = firstLoad.requests.filter((request) =>
      request.complete && !request.failed && request.status === 200 && Number.isSafeInteger(request.responseBytes) && request.responseBytes > 0);
    assert.ok(successfulFirstLoadRequests.some((request) => request.type === 'Document' && request.path === '/items'),
      'first load captured the local document response with positive encoded bytes');
    assert.ok(successfulFirstLoadRequests.some((request) => request.method === 'GET' && request.path === '/api/v1/boards'),
      'first load captured the board-list API response with positive encoded bytes');
    assert.ok(successfulFirstLoadRequests.some((request) => request.method === 'GET' && /^\/api\/v1\/boards\/[^/]+\/state$/u.test(request.path)),
      'first load captured a board-state API response with positive encoded bytes');
    assert.equal(report.actions.at(-1).samples[0].liveWrites, 6, 'the idle sample includes six five-second live writes');
    assert.equal(report.actions.at(-1).samples[0].renderedWrites, 6, 'all six live writes appeared in the open feed during the idle sample');
    // Every observed JSON request is represented in the rendered action row; the one run serves this and the checks above.
    assert.ok(report.actions.some((action) => action.requestsPerRun[0].length > 0),
      'the table comparison has at least one observed request to verify');
    for (const action of report.actions) {
      const row = report.table.split('\n').find((line) => line.startsWith(`| ${action.name} |`));
      assert.ok(row, `${action.name} has a table row`);
      for (const request of action.requestsPerRun[0]) {
        const bytes = Number.isSafeInteger(request.responseBytes) ? `${request.responseBytes} B` : 'unavailable';
        assert.ok(row.includes(`${request.method} ${request.path} = ${bytes}`),
          `${action.name} table row includes the request represented in JSON`);
      }
    }
  });
});
