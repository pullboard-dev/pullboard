/** A fresh board with a joined agent and a runner that finished its gates reports both, not 0 agents and no runners [C7]. */
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { projectState } from '../../../src/io/serve.js';
import { readLiveRunners } from '../../../src/io/live/read.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';

test('view.x-io-live-joined.clause-1-a-joined-agent-that-holds: clause 1: a joined agent that holds no claim is counted as joined beside the agents at work [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  cellSeat(board, { lane: 'web', path: project.repo + '/.claude/worktrees/web-1' });
  const state = projectState(project.repo, { board });
  assert.equal(state.counts.agents, 0, 'nobody holds a claim, so nobody is at work');
  assert.equal(state.counts.joined, 1, 'the joined seat shows, and the coordinator does not count');
});

test('view.x-io-live-joined.clause-1-the-runner-that-ran-and: clause 1: the runner that ran and finished a gate stays on the card after the job clears its lease owner [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  const common = dirname(dirname(project.boardFile)), now = Date.now(), offeredAt = now - 10 * 60_000;
  offerJob(board.db, { id: 'gate:1:a', kind: 'gate', needs: [], item: 1, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: offeredAt });
  assert.ok(claimJob(board.db, { runner: 'local-host.local-61498', capabilities: [], now: offeredAt + 1000, leaseMs: 60_000 }), 'the runner claimed the gate');
  // A finished job, as the real board keeps it: no lease owner, the claimed step still naming the runner.
  board.db.prepare("UPDATE job SET job_step = 'done', job_lease_owner = NULL, job_lease_until = ? WHERE job_id = 'gate:1:a'").run(offeredAt + 6000);
  const read = readLiveRunners({ roots: [{ commonDir: common }], now, resources: join(common, 'none.sqlite'), openBoardReadOnly: store.openBoardReadOnly });
  assert.deepEqual(read.runners.map(runner => runner.host), ['local-host.local'], 'one runner, without its process id');
  assert.equal(projectState(project.repo, { board }).counts.runners, 1);
});

test('view.x-io-live-joined.clause-1-the-dashboard-agents-heading-names: clause 1: the dashboard Agents heading names the joined seats beside the agents at work [C7]', t => {
  const project = cellProject(t), board = cellBoard(t, project.boardFile);
  cellSeat(board, { lane: 'web', path: project.repo + '/.claude/worktrees/web-1' });
  const state = projectState(project.repo, { board });
  const html = dashboardHtml(dashboardModel(state, [], { now: Date.now(), complete: false }));
  assert.match(html, /title="Agents at work">0<\/button>.*? · 4 h · 1 joined/u, 'no one is at work, and the heading still shows the joined seat');
});
