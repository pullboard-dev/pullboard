// pullboard: browser
/** @pullboard-test-gui */
/** Exercise the deterministic stress fixture and the real-Chrome performance harness [N26]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  cleanupFixtureChildren,
  runFixtureChildAsync,
} from '../../tests/fixtures/child.js';
import {
  generateStressBoard,
  removeStressBoard,
} from '../../tests/fixtures/cockpit/perf/generate.mjs';
import {
  assertRequiredNetworkEvidence,
  selectNetworkTarget,
  withPerfSlot,
} from '../../tests/fixtures/cockpit/perf/run.mjs';

after(cleanupFixtureChildren);

test('the harness measures with eight registered projects [N26,N40]', async (t) => {
  const fixtures = [];
  t.after(() => {
    if (t.passed) for (const fixture of fixtures) removeStressBoard(fixture);
  });
  const root = resolve(import.meta.dirname, '../../../..');
  for (const projects of [8, 1]) {
    const result = await runFixtureChildAsync(process.execPath, [join(root, 'apps/cli/tests/fixtures/cockpit/perf/run.mjs'),
      ...(projects > 1 ? ['--projects', String(projects)] : []),
      '--size', '5', '--runs', '1', '--idle', '1', '--live-every', '1', '--keep'],
    { cwd: root, env: process.env });
    assert.equal(result.status, 0, result.context);
    const kept = /^Generated board kept at (.+)$/mu.exec(result.stdout);
    assert.ok(kept, 'the CLI retains its private fixture for independent registry checks');
    const workspace = dirname(kept[1]);
    const fixture = { ...JSON.parse(readFileSync(join(workspace, 'stress-board.json'), 'utf8')), workspace };
    fixtures.push(fixture);
    const end = result.stdout.indexOf('\n\n| action |');
    assert.ok(end > 0, 'the harness prints its JSON before the existing table');
    const report = JSON.parse(result.stdout.slice(0, end));
    assert.equal(report.projects, projects, 'the JSON records the measured project count');
    assert.equal(report.projectNames.length, projects, 'the real view lists every requested project');
    assert.equal(new Set(report.projectNames).size, projects, 'the projects have distinct names');
    const registered = JSON.parse(readFileSync(join(fixture.home, 'projects.json'), 'utf8')).projects;
    assert.equal(registered.length, projects, 'the stress home contains the requested real projects');
    assert.equal(new Set(registered.map((project) => project.root)).size, projects);
    for (const project of registered) {
      assert.ok(existsSync(join(project.root, '.git/pullboard/board.sqlite')), 'each project has its own board');
    }
    const switching = report.actions.filter((action) => action.name === 'switchProject');
    assert.equal(switching.length, projects > 1 ? 1 : 0,
      'only a multi-project run measures a real project switch');
    for (const action of switching) {
      assert.ok(action.samples.every((sample) => sample.stable === true), 'the switch reaches the stress board');
      assert.ok(Number.isFinite(action.medianMs) && Number.isFinite(action.worstMs), 'switch latency is measured');
    }
    assert.deepEqual(report.actions.filter((action) => action.name !== 'switchProject').map((action) => action.name),
      ['firstLoad', 'tab:shouts', 'tab:spec', 'tab:doctrine', 'tab:activity', 'tab:roadmap', 'tab:items',
        'openSmallItem', 'openLongestHistoryItem', 'search', 'idleWithLiveWrites'], 'the eleven existing actions stay intact');
    assert.equal(report.size, 5, 'the measured stress-board size is preserved');
    t.diagnostic(JSON.stringify({ projects: report.projects, size: report.size,
      projectNames: report.projectNames, actions: report.actions.map((action) => action.name) }));
  }
});

/** Check every observed JSON request is represented in the rendered action row. */
async function tableListsRequestBytes(t) {
  let fixture = null;
  t.after(() => {
    if (!t.passed) {
      console.error(`Performance evidence retained at ${fixture?.workspace ?? 'fixture setup did not finish'}`);
      return;
    }
    if (fixture) removeStressBoard(fixture);
  });
  await withPerfSlot(async (run) => {
    const evidenceRoot = process.env.PULLBOARD_PERF_EVIDENCE_ROOT;
    fixture = generateStressBoard({ seed: 'request-table', size: 5, ...(evidenceRoot ? { parent: evidenceRoot } : {}) });
    const report = await run({ board: fixture, runs: 1, idleMs: 1_000, liveEveryMs: 1_000 });
    const firstLoad = report.actions.find((action) => action.name === 'firstLoad')?.requestsPerRun[0] ?? [];
    assert.ok(firstLoad.length > 0, 'the JSON report contains observed first-load requests');
    const successfulFirstLoad = firstLoad.filter((request) => request.complete && !request.failed && request.status === 200
      && Number.isSafeInteger(request.responseBytes) && request.responseBytes > 0);
    assert.ok(successfulFirstLoad.some((request) => request.type === 'Document' && request.path === '/items'),
      'the JSON report contains the successful document response');
    assert.ok(successfulFirstLoad.some((request) => request.method === 'GET' && request.path === '/api/v1/boards'),
      'the JSON report contains the successful board-list response');
    assert.ok(successfulFirstLoad.some((request) => request.method === 'GET' && /^\/api\/v1\/boards\/[^/]+\/state$/u.test(request.path)),
      'the JSON report contains the successful board-state response');
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
}

test("the harness table lists each request's bytes [N26]", tableListsRequestBytes);

test('network observation stays attached to the selected page and rejects missing required bytes [N26]', () => {
  const targets = [
    { id: 'first-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://first' },
    { id: 'owned-blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://owned' },
  ];
  assert.equal(targets.find((target) => target.type === 'page' && target.url === 'about:blank').id, 'first-blank',
    'the legacy first-blank lookup selects a different page in this two-target control');
  assert.equal(selectNetworkTarget(targets, 'owned-blank').id, 'owned-blank',
    'network observation follows the exact page selected by the Chrome fixture');
  assert.throws(() => selectNetworkTarget(targets, 'missing'), /was not listed/u);
  assert.throws(() => assertRequiredNetworkEvidence('firstLoad', [], 0), /unavailable/u);
  assert.throws(() => assertRequiredNetworkEvidence('idleWithLiveWrites', [{ path: '/events' }], 0), /unavailable/u);
  assert.doesNotThrow(() => assertRequiredNetworkEvidence('tab:shouts', [], 0),
    'an action without network requests may report zero when the observer remains live');
});

test('the perf harness measures every action on a stress board [N26]', async (t) => {
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
  });
});
