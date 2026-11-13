import { nativeBoardPorts as relayPresentationNativePorts } from '../../../../lib/index.js';
import { openBoard } from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { allShouts } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { presentationShout } from '../../../../../packages/pages/index.js';
import { relayPresentation } from '../../../../../packages/pages/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { apiError } from '../../../tests/fixtures/api.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { assertRequiredShape } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';
import { fixtureJsonStep } from '../../../tests/fixtures/api/milestone.js';

test('[N38] local API and sealed presentation resolve shouts beyond recent state, with complete export history', async (t) => {
  const box = project();
  const api = await startLocalHandler(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const boardId = boards.boards.find((candidate) => candidate.root === box.repo).id;
  const boardPath = `/api/v1/boards/${boardId}`;
  /** Run one CLI step in this process and return its JSON document, so the 40 shouts below pay no node start-up each. */
  const step = async (command, args) => (await fixtureJsonStep(box, `${command} ${args[1] ?? ''}`, box.repo, command, args)).document;
  const decision = await step('shout', ['person', 'An old decision', '--decision']);
  await step('answer', [String(decision.id), 'Approved', '--as', 'person']);
  const openDecision = await step('shout', ['person', 'An old open decision', '--decision']);
  for (let index = 0; index < 40; index += 1) await step('shout', ['app', `recent message ${index}`]);

  const state = await (await apiFetch(api, `${boardPath}/state`)).json();
  assert.equal(state.state.shouts.length, 40);
  assert.ok(!state.state.shouts.some((shout) => shout.shout_id === decision.id), 'the addressed shout is older than the existing recent-40 state');
  assert.ok(!state.state.shouts.some((shout) => shout.shout_id === openDecision.id));
  const direct = await apiFetch(api, `${boardPath}/shouts/${decision.id}`);
  assert.equal(direct.status, 200);
  const directDocument = await direct.json();
  assertRequiredShape(directDocument, JSON_SHAPES.http.shout.required, 'shout response');
  assert.equal(directDocument.version, JSON_SHAPES.version);
  const oldShout = directDocument.shout;
  assert.equal(oldShout.shout_id, decision.id);
  assert.equal(oldShout.shout_from, 'coordinator');
  assert.equal(oldShout.shout_to, 'person');
  assert.equal(oldShout.shout_text, 'An old decision');
  assert.equal(oldShout.shout_decision, 1);
  assert.equal(oldShout.decision_state, 'answered');
  assert.equal(oldShout.decision_answer.shout_text, 'Approved');
  assert.ok(oldShout.shout_at);
  const open = await (await apiFetch(api, `${boardPath}/shouts/${openDecision.id}`)).json();
  assert.equal(open.shout.decision_state, 'open');
  assert.equal(open.shout.decision_answer, null);

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let history;
  try { history = allShouts(board); } finally { closeBoard(board); }
  assert.equal(history.length, 43);
  const answer = history.find((shout) => shout.shout_answers === decision.id);
  assert.ok(answer, 'the complete read retains the decision reply relationship');
  assert.equal(answer.shout_text, 'Approved');
  const presentation = relayPresentation(box.repo, {}, relayPresentationNativePorts().presentation);
  assert.throws(() => presentationShout({ state: presentation.state }, decision.id), { code: 'SHOUT_NOT_AVAILABLE' },
    'older snapshots without complete history refuse the capability clearly');
  assert.equal(presentation.shouts.length, 43);
  assert.equal(presentation.shouts[0].shout_id, decision.id);
  assert.equal(presentation.shouts[0].shout_text, 'An old decision');
  assert.equal(presentation.state.shouts.length, 40, 'sealed presentation keeps the state window bounded separately');

  const linkFile = join(box.repo, '.git', 'pullboard', 'relay.json');
  writeFileSync(linkFile, JSON.stringify({ version: 1, mode: 'ordered', board: boardId,
    url: 'https://app.pullboard.dev', repository: 'fixture/repository', token: 'ps_' + 'a'.repeat(43), sequence: 0, cursor: 0 }) + '\n', { mode: 0o600 });
  const throughRelayPresentation = await apiFetch(api, `${boardPath}/shouts/${decision.id}`);
  const relayDocument = await throughRelayPresentation.json();
  assert.equal(throughRelayPresentation.status, 200, JSON.stringify(relayDocument));
  assert.deepEqual(relayDocument.shout, JSON.parse(JSON.stringify(oldShout)));

  const missing = await apiFetch(api, `${boardPath}/shouts/999999`);
  assert.equal((await apiError(missing, 404)).code, 'NO_SHOUT');
  const malformed = await apiFetch(api, `${boardPath}/shouts/0`);
  assert.equal((await apiError(malformed, 400)).code, 'BAD_REQUEST');
  const malformedText = await apiFetch(api, `${boardPath}/shouts/nope`);
  assert.equal((await apiError(malformedText, 400)).code, 'BAD_REQUEST');
  await apiError(await apiFetch(api, `${boardPath}/shouts/${decision.id}`, { noSecret: true }), 401);
  await apiError(await apiFetch(api, `${boardPath}/shouts/${decision.id}`, { headers: { 'x-pullboard-key': 'wrong-session-secret' } }), 401);
  assert.equal((await (await apiFetch(api, `${boardPath}/state`)).json()).state.shouts.length, 40,
    'addressed reads and refusals do not change the recent-40 projection');
});

