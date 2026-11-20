/** A board whose agents and runner just finished their work still shows both on the Dashboard, not 0 and No runs [C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { projectState } from '../../../src/io/serve.js';
import { boardCounts } from '../../../src/logic/counts.js';
import { finishedRuns } from '../../../src/io/serve.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';

test('view.x-io-live-finished.clause-1-an-agent-that-joined-and: clause 1: an agent that joined and holds no claim is a row of the Agents table, not hidden behind a toggle [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  cellSeat(board, { lane: 'web', path: project.repo + '/.claude/worktrees/web-1' });
  const state = projectState(project.repo, { board });
  assert.deepEqual(state.counts.agentIds, [], 'nobody is at work, so the shared list of agents at work is empty');
  const model = dashboardModel(state, [], { now: Date.now(), complete: false, working: state.counts.agentIds });
  assert.deepEqual(model.agents.map(agent => agent.id), ['web-1'], 'the joined seat that just moved is on the model');
  const html = dashboardHtml(model);
  assert.match(html, /data-dashboard-agent="web-1"/u, 'its row is drawn');
  assert.doesNotMatch(html, /data-dashboard-quiet-rows hidden/u, 'and the rows are open when nobody is building or reviewing');
});

test('view.x-io-live-finished.clause-1-the-runner-card-names-the: clause 1: the runner card names the runs it finished in the last four hours beside the ones in flight [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  const common = dirname(dirname(project.boardFile)), now = Date.now(), offeredAt = now - 10 * 60_000;
  for (const [id, kind] of [['gate:1:a', 'gate'], ['gate:1:b', 'gate'], ['land:1:c', 'landing']]) {
    offerJob(board.db, { id, kind, needs: [], item: 1, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: offeredAt });
    assert.ok(claimJob(board.db, { runner: 'local-host.local-61498', capabilities: [], now: offeredAt + 1000, leaseMs: 60_000 }), 'the runner claimed the job');
  }
  board.db.prepare("UPDATE job SET job_step = 'done', job_lease_owner = NULL, job_updated = ?").run(now - 60_000);
  assert.deepEqual(finishedRuns(common, now), { gate: 2, landing: 1, test: 0 });
  assert.deepEqual(finishedRuns(common, now + 5 * 3_600_000), { gate: 0, landing: 0, test: 0 }, 'a run older than four hours is not counted');
  const state = { ...projectState(project.repo, { board }), dashboardRunners: { runners: [{ runner: 1, state: 'idle', busy: false, cpu: null, ram: null, jobs: [] }], runs: [], finished: finishedRuns(common, now) } };
  const html = dashboardHtml(dashboardModel(state, [], { now, complete: false }));
  assert.match(html, /None in flight\. Ran in the last 4 hours: 2 gates, 1 landings\./u);
  assert.doesNotMatch(html, /No runs\./u);
});

test('view.x-io-live-finished.clause-1-a-runner-that-ran-nothing: clause 1: a runner that ran nothing still reads No runs [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  const state = { ...projectState(project.repo, { board }), dashboardRunners: { runners: [{ runner: 1, state: 'idle', busy: false, cpu: null, ram: null, jobs: [] }], runs: [], finished: { gate: 0, landing: 0, test: 0 } } };
  assert.match(dashboardHtml(dashboardModel(state, [], { now: Date.now(), complete: false })), /No runs\./u);
});

test('view.x-io-live-finished.clause-1-the-landed-count-agrees-across: clause 1: the landed count agrees across the top bar counts and the Dashboard landed panel once the finished items are read [C7]', () => {
  const now = Date.parse('2026-11-15T18:00:00Z');
  const entries = [1, 2, 3].map(id => ({ id, commit: String(id).repeat(40), at: now - id * 600_000 }));
  const items = entries.map(entry => ({ id: entry.id, title: 't' + entry.id, lane: 'view', specs: [], status: 'withdrawn', merged: entry.commit }));
  const openFirst = { items: [], itemsOmitted: 'finished', dashboardLanded: entries };
  assert.equal(boardCounts(openFirst, now).landed.last4h, 3, 'the top bar counts the recent landings even while their items are omitted');
  assert.equal(dashboardModel(openFirst, [], { now, complete: true }).lists.landed.length, 0, 'the panel cannot name items the open-first state left out, which is why the refresh reads them');
  const full = { items, dashboardLanded: entries };
  const counted = boardCounts(full, now).landed;
  assert.deepEqual([counted.total, counted.last4h], [3, 3], 'with the items read the top bar still counts 3');
  const model = dashboardModel(full, [], { now, complete: true });
  assert.equal(model.lists.landed.length, counted.last4h, 'the Dashboard landed panel lists the same number the top bar counts');
  assert.match(dashboardHtml(model), /Nothing landed in the last 4 hours|Landed · 4 h/u);
  assert.doesNotMatch(dashboardHtml(model), /Nothing landed in the last 4 hours/u, 'and it does not claim none landed');
});
