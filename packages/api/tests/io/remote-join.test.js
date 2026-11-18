/** A seat on another machine joins a served board over the API and its moves run at the board root, not refused WRONG_BOARD [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { agentById } from '../../../store/index.js';
import { isRemoteAgentPath } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { FIXTURE_MODEL } from '../../../gate/tests/fixtures/testkit.js';
import { executeMove } from '../../index.js';

/** The board openers and move mapping the higher composition root hands the API. */
const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

/** A command runner standing in for the CLI: it records each call and answers with one event acting as the caller. */
function recordingRunner() {
  const calls = [];
  const run = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd, remoteAgent: options.remoteAgent });
    options.onEvent({ event_kind: argv[0], event_by: options.remoteAgent ?? 'coordinator' });
    options.stdout.write('{}');
    return 0;
  };
  return { calls, run };
}

/** Read one agent row from the served board file. */
function agentRow(file, id) {
  const board = openCellBoard(file);
  try { return agentById(board, id); } finally { closeCellBoard(board); }
}

/** Join a lane over the API as a seat from another machine, and return its agent name. */
async function remoteJoin(project, runner) {
  const joined = await executeMove(project.repo, { verb: 'join', args: { lane: 'web', model: FIXTURE_MODEL } }, runner.run, false, 'api', refusalDocument, OPENERS);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return joined.body.result.agent;
}

test('api.remote-join.join-over-api-registers-agent: clause 1: a join over the API registers an agent on the served board with no board-host path [P7]', async (t) => {
  const project = cellProject(t, { real: true });
  const runner = recordingRunner();
  const agent = await remoteJoin(project, runner);
  assert.match(agent, /^web-/u);
  assert.deepEqual(runner.calls, [], 'a remote join registers the seat itself and runs no CLI in any checkout');
  const row = agentRow(project.boardFile, agent);
  assert.equal(row.agent_lane, 'web');
  assert.equal(row.agent_model, FIXTURE_MODEL);
  assert.equal(isRemoteAgentPath(row.agent_path), true, 'the agent carries a remote marker in place of a path');
  assert.equal(existsSync(row.agent_path), false, 'the agent has no path on the board host');
});

test('api.remote-join.move-posted-remote-agent-runs: clause 2: a move posted as the remote agent runs at the board root as that agent instead of refusing WRONG_BOARD [P7]', async (t) => {
  const project = cellProject(t, { real: true });
  const runner = recordingRunner();
  const agent = await remoteJoin(project, runner);
  const moved = await executeMove(project.repo, { verb: 'shout', agent, args: { to: 'coordinator', kind: 'question', text: 'remote seat reporting' } }, runner.run, false, 'api', refusalDocument, OPENERS);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(runner.calls, [{ argv: ['shout'], cwd: project.repo, remoteAgent: agent }]);
  assert.equal(moved.body.event.event_by, agent, 'the move acts as the remote agent, not the coordinator');
});

test('api.remote-join.local-agent-whose-worktree-belongs: clause 3: a local agent whose worktree belongs to another board still refuses WRONG_BOARD [P7]', async (t) => {
  const project = cellProject(t, { real: true });
  const other = cellRepo(t, { real: true });
  const board = openCellBoard(project.boardFile);
  let agent;
  try { agent = cellSeat(board, { lane: 'web', path: other.root }).id; } finally { closeCellBoard(board); }
  const runner = recordingRunner();
  const moved = await executeMove(project.repo, { verb: 'shout', agent, args: { to: 'coordinator', text: 'from another board' } }, runner.run, false, 'api', refusalDocument, OPENERS);
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.error.code, 'WRONG_BOARD');
  assert.deepEqual(runner.calls, [], 'a refused move runs no command');
});
