/** With gate.retryNewRedsOnce on, the board API's job queue offers the one retry shard for a gate red only in new cases; unset, it offers none [C7,P7,#11818]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureMachineSettings } from '../../gate/tests/fixtures/testkit.js';
import { closeCellBoard } from '../../board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../store/tests/fixtures/cell.js';
import { cellItem } from '../../store/tests/fixtures/cell.js';
import { cellProject } from '../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../store/tests/fixtures/cell.js';
import { headTree } from '../../git/index.js';
import { openBoardForRead } from '../../store/index.js';
import * as store from '../../store/index.js';
import { claimJob } from '../index.js';
import { offerJob } from '../index.js';
import { poolHandlers } from '../index.js';
import { provideMainComparison } from '../index.js';
import { shardJobs } from '../index.js';

const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });
const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'];
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
const RED = { file: 'web/a.test.js', name: 'loads under load' };
/** The main-receipt lookup of a board whose main fails none of the red cases: every red case is new. */
const NEW_AGAINST_MAIN = ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'item', own: [], receipt: null, job: null })) });
const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } });
const red = head => ({ version: 1, status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1, failures: [RED], tail: 'not ok' }] } });

/** Run a sharded gate whose first shard is red only in new cases through the real queue handler, with the machine setting given; returns the last receipt's outcome and the retry jobs offered. */
async function gateOutcome(t, setting) {
  const project = cellProject(t, { real: true });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { gate: { fencedHop: false, ...(setting === undefined ? {} : { retryNewRedsOnce: setting }) } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  provideMainComparison(NEW_AGAINST_MAIN);
  t.after(() => { provideMainComparison(null); if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const head = project.git(project.repo, 'rev-parse', 'HEAD');
  const parent = 'gate:retry-setting';
  const board = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
  let lease, item;
  try {
    const seat = cellSeat(board, { lane: 'web', path: `${project.repo}/seat` });
    item = cellItem(board, { lane: 'web', title: 'Build the page' });
    cellClaim(board, item.item_id, seat, { root: project.repo });
    const held = store.getItem(board, item.item_id);
    offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
      request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree: headTree(project.repo), files: [] } } });
    lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  } finally { closeCellBoard(board); }
  const handlers = poolHandlers({ boardOpeners: OPENERS });
  const call = (body, now) => handlers.jobs({ board: { id: 'fixture', root: project.repo }, body, now });
  const gate = { version: 1, source: head, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: 'node --test' },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const sharded = await call({ action: 'receipt', job: parent, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, 3);
  assert.equal(sharded.applied.outcome, 'sharded', JSON.stringify(sharded.applied));
  let last = null;
  for (const [index, shard] of sharded.applied.shards.entries()) {
    const at = 10 * (index + 1);
    const reopened = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
    let claimed;
    try { claimed = claimJob(reopened.db, { runner: `r-${at}`, capabilities: [], now: at }); } finally { closeCellBoard(reopened); }
    assert.equal(claimed?.job, shard);
    last = (await call({ action: 'receipt', job: shard, runner: `r-${at}`, token: claimed.token, receipt: index === 0 ? red(head) : green(head) }, at + 1)).applied;
  }
  const reopened = openCellBoard(project.boardFile, undefined, { gitRoot: project.repo });
  try { return { outcome: last.outcome, retry: shardJobs(reopened.db, parent).filter(row => row.job_id === `${parent}:shard:retry`) }; } finally { closeCellBoard(reopened); }
}

test('api.io-main-retry-setting.setting-on-offers-the-retry-shard: clause 1: with gate.retryNewRedsOnce true, a sharded parent whose red cases are all onMain false gets one retry job offered through the real queue handler [C7,P7,#11818]', async t => {
  const answer = await gateOutcome(t, true);
  assert.equal(answer.outcome, 'retrying');
  assert.equal(answer.retry.length, 1, 'one retry job');
});

test('api.io-main-retry-setting.setting-unset-offers-none: clause 2: with gate.retryNewRedsOnce unset the same parent gets no retry job and its red applies as before [C7,P7,#11818]', async t => {
  const answer = await gateOutcome(t, undefined);
  assert.equal(answer.outcome, 'red');
  assert.equal(answer.retry.length, 0, 'no retry job');
});
