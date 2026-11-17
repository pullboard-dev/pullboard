/** A board whose relay on switched its id still answers runners pointed at the previous id [P7,H17] (#7772). */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { offerJob } from '../../index.js';
import { serveApi } from '../../index.js';

const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`a job call does not project ${name}`); }])));
const PREVIOUS = 'a'.repeat(32);

/** Serve one temp board with a queued job, a pull-mode machine, and (optionally) the relink intent that names PREVIOUS. */
async function served(t, { relink }) {
  const project = cellProject(t, { real: true });
  const board = openCellBoard(project.boardFile);
  let current;
  try { current = boardId(board); offerJob(board.db, { id: 'test:relink:one', kind: 'test', now: 1000 }); } finally { closeCellBoard(board); }
  if (relink) {
    mkdirSync(dirname(project.boardFile), { recursive: true });
    writeFileSync(join(dirname(project.boardFile), 'relay-relink.json'), JSON.stringify({ version: 1, previous: PREVIOUS, next: current }) + '\n', { mode: 0o600 });
  }
  const home = join(project.dir, 'machine-home');
  mkdirSync(home, { recursive: true });
  // gate.fencedHop is on by default (3e125d823d) and this journey serves no hop table: the relink answer is the subject, not the hop [C7].
  fixtureMachineSettings(home, { gate: { runnerDispatch: 'pull', fencedHop: false } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const secret = 'fixture-secret';
  const api = await serveApi({ projects: () => [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-14' }], secret, runCommand: async () => 0, isMain: false,
    refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }), boardOpeners: OPENERS, viewPorts: VIEW_PORTS });
  t.after(() => api.close());
  const claim = async (id) => {
    const response = await fetchFresh(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/jobs?k=${secret}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim', runner: 'r1', capabilities: [] }) });
    return { status: response.status, body: await response.json() };
  };
  return { current, claim };
}

test('api.relink-alias.clause-h17-runner-pointed-relink: clause 1 [P7,H17]: a runner pointed at the id the relink names as previous claims a job from the board that carries the next id (#7772)', async (t) => {
  const { current, claim } = await served(t, { relink: true });
  const old = await claim(PREVIOUS);
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.equal(old.body.claim?.job, 'test:relink:one', JSON.stringify(old.body));
  const again = await claim(current);
  assert.equal(again.status, 200, 'the current id still answers');
});

test('api.relink-alias.clause-h17-relink-naming-unknown: clause 1 [P7,H17]: with no relink naming it, an unknown id still answers NO_BOARD (#7772)', async (t) => {
  const { claim } = await served(t, { relink: false });
  const answer = await claim(PREVIOUS);
  assert.equal(answer.body.error?.code, 'NO_BOARD', JSON.stringify(answer.body));
});
