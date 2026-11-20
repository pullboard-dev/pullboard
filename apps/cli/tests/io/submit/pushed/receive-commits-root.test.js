/** A URL-joined seat's bundled submit runs in the folder receiveCommits placed, whose head differs from main (pin and api level) [C7,P7,#10218]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../../../packages/board/tests/fixtures/cell-board.js';
import { closeCellBoard } from '../../../../../../packages/board/tests/fixtures/cell-board.js';
import { agentById } from '../../../../../../packages/store/index.js';
import { getItem } from '../../../../../../packages/store/index.js';
import { openBoardForRead } from '../../../../../../packages/store/index.js';
import { FIXTURE_MODEL } from '../../../fixtures/testkit.js';
import { executeMove } from '../../../../../../packages/api/index.js';
import { requireNonEmptySubmit } from '../../../../src/io/empty.js';
import { bundleCommits } from '../../../../../../packages/pin/index.js';
import { receiveCommits } from '../../../../../../packages/pin/index.js';

const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb], receiveCommits });

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

/** A command runner standing in for the CLI: it records each call's cwd and answers with one submit event. */
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

/** A served board with one item claimed by a URL-joined seat, and the seat's clone with one commit past main, bundled for the move. */
async function world(t) {
  const project = cellProject(t, { real: true });
  const runner = recordingRunner();
  const joined = await executeMove(project.repo, { verb: 'join', args: { lane: 'web', model: FIXTURE_MODEL } }, runner.run, false, 'api', refusalDocument, OPENERS);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const agent = joined.body.result.agent;
  const board = openCellBoard(project.boardFile);
  let item;
  try {
    const seat = { ...agentById(board, agent), id: agent, lane: 'web' };
    item = cellItem(board, { lane: 'web', title: 'Remote seat item' }).item_id;
    cellClaim(board, item, seat, { root: project.repo });
    assert.equal(getItem(board, item).item_owner, agent);
  } finally { closeCellBoard(board); }
  const main = project.git(project.repo, 'rev-parse', 'HEAD').trim();
  const clone = join(project.dir, 'seat-clone');
  project.git(project.dir, 'clone', '--quiet', project.repo, clone);
  project.git(clone, 'config', 'user.name', 'Test Agent');
  project.git(clone, 'config', 'user.email', 'agent@example.com');
  runner.calls.length = 0;
  writeFileSync(join(clone, 'web-change.txt'), 'the seat work\n');
  project.git(clone, 'add', '-A');
  project.git(clone, 'commit', '--quiet', '-m', 'feat(web): seat work [G1]');
  const commits = bundleCommits(clone, { item, agent });
  return { project, runner, agent, item, main, commits };
}

test('cli.io-submit-pushed-receive-commits-root.folder-head-differs-from-main: clause 1: after receiveCommits places a seat\'s one-commit bundle, the returned remote-items folder has a head whose diff against main is not empty, so requireNonEmptySubmit throws nothing [C7,P7]', async (t) => {
  const w = await world(t);
  const body = { verb: 'submit', item: w.item, agent: w.agent, commits: w.commits };
  const seat = { remoteAgent: w.agent };
  const folder = receiveCommits(w.project.repo, body, seat, (read) => { const board = openCellBoard(w.project.boardFile); try { return read(board); } finally { closeCellBoard(board); } }, getItem);
  assert.equal(w.project.git(folder, 'rev-parse', 'HEAD').trim(), w.commits.head, 'the folder is left at the seat\'s commit');
  assert.notEqual(w.project.git(folder, 'rev-parse', 'HEAD').trim(), w.main, 'the head is not main');
  assert.notEqual(w.project.tryGit(folder, 'diff', '--quiet', w.main, w.commits.head).status, 0, 'the head differs from main');
  assert.doesNotThrow(() => requireNonEmptySubmit(folder, w.item, w.commits.head, w.main));
});

test('cli.io-submit-pushed-receive-commits-root.submit-runs-in-returned-folder: clause 2: executeMove with verb submit and a stub runCommand runs the command in the folder receiveCommits returned, not the claim item folder [C7,P7]', async (t) => {
  const w = await world(t);
  const moved = await executeMove(w.project.repo, { verb: 'submit', item: w.item, agent: w.agent, commits: w.commits }, w.runner.run, false, 'api', refusalDocument, OPENERS);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(w.runner.calls.length, 1);
  const [call] = w.runner.calls;
  assert.notEqual(call.cwd, w.project.repo, 'not the board root');
  assert.match(call.cwd, /remote-items[\\/].*-item-\d+$/u, 'the remote-items folder');
  assert.equal(w.project.git(call.cwd, 'rev-parse', 'HEAD').trim(), w.commits.head, 'that folder holds the seat\'s head');
  assert.doesNotThrow(() => requireNonEmptySubmit(call.cwd, w.item, w.commits.head, w.main));
});
