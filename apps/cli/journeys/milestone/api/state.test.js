import { nativeBoardPorts as relayPresentationNativePorts } from '../../../../lib/index.js';
import { openBoard } from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { addLightViaCli } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { runLocal } from '../../../tests/fixtures/api/milestone.js';
import { jsonError } from '../../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';

test('[N26,A2] roadmap text, JSON and API state follow live local and registered repo items', async (t) => {
  const box = project();
  const foreign = project();
  const foreignConfigFile = join(foreign.repo, 'pullboard.json');
  const foreignConfig = JSON.parse(readFileSync(foreignConfigFile, 'utf8'));
  foreignConfig.name = 'foreign';
  writeFileSync(foreignConfigFile, `${JSON.stringify(foreignConfig, null, 2)}\n`);
  const registryFile = join(box.env.PULLBOARD_HOME, 'projects.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  registry.projects.push({ root: foreign.repo, name: 'foreign', project: '', added: '2026-10-08T00:00:00.000Z' });
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  const addArgs = (title) => [
    'app', title, '--route', 'mid', '--criterion', 'roadmap item', '--check', 'true',
    '--brief', 'Files:\n- app/roadmap.js\nChange: track this work\nTest: inspect its status',
  ];
  const localItem = addLightViaCli(json, box, box.repo, addArgs('Local release')).item;
  const externalItem = addLightViaCli(json, foreign, foreign.repo, addArgs('External follow-up')).item;
  const worktree = json(box, box.repo, 'worktree', ['app', '--route', 'light'], 'worktree');

  json(box, box.repo, 'milestone', ['add', 'Delivery', '--note', 'Ship the release', '--reason', 'Arrange fixture release', '--items', `${localItem.item_id},foreign#${externalItem.item_id}`], 'add');
  json(box, box.repo, 'milestone', ['add', 'Aftercare'], 'add');
  json(box, box.repo, 'milestone', ['move', 'Aftercare', '--before', 'Delivery'], 'move');
  await jsonError(box, worktree.path, 'milestone', ['add', 'Forbidden'], {
    status: 1,
    code: 'COORDINATOR_ONLY',
    message: 'only the coordinator changes milestones; ask your coordinator to update the roadmap',
    next: 'ask your coordinator to update the roadmap',
  }, 'add');
  const claim = await runLocal(box, worktree.path, 'claim', String(localItem.item_id), '--json');
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);

  const textRoadmap = await runLocal(box, box.repo, 'roadmap');
  assert.equal(textRoadmap.status, 0, textRoadmap.stderr);
  assert.ok(textRoadmap.stdout.includes('Aftercare: 0/0 landed') && textRoadmap.stdout.indexOf('Aftercare: 0/0 landed') < textRoadmap.stdout.indexOf('Delivery: 0/2 landed'),
    'the roadmap counts landed items, in milestone order');
  assert.match(textRoadmap.stdout, /Ship the release/);
  assert.match(textRoadmap.stdout, new RegExp(`#${localItem.item_id} Local release — claimed`));
  assert.match(textRoadmap.stdout, new RegExp(`foreign#${externalItem.item_id} External follow-up — open`));

  const document = json(box, box.repo, 'roadmap');
  assert.deepEqual(document.milestones.map(({ name }) => name), ['Aftercare', 'Delivery']);
  assert.deepEqual(document.milestones[1].items.map(({ status }) => status), ['claimed', 'open']);
  // The handler reads the project registry from this process's home, as the served board's own process does with the box's [N26].
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (previousHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousHome; });
  const api = await startLocalHandler(t, box);
  const listing = await (await apiFetch(api, '/api/v1/boards')).json();
  const current = listing.boards.find((candidate) => candidate.root === box.repo);
  const response = await apiFetch(api, `/api/v1/boards/${current.id}/state`);
  const state = await response.json();
  assert.equal(response.status, 200);
  const shape = (milestones) => milestones.map(({ name, count, landed, total, withdrawn, items }) => ({ name, count, landed, total, withdrawn, items: items.map(({ id, state }) => [id, state]) })); assert.deepEqual(shape(state.state.milestones), shape(document.milestones)); // state keeps no per-item progress or idle clock (#6665)
});

test('[N38] local API and sealed presentation resolve shouts beyond recent state, with complete export history', async (t) => {
  const box = project();
  const api = await startLocalHandler(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const boardId = boards.boards.find((candidate) => candidate.root === box.repo).id;
  const boardPath = `/api/v1/boards/${boardId}`;
  const decision = json(box, box.repo, 'shout', ['person', 'An old decision', '--decision']);
  json(box, box.repo, 'answer', [String(decision.id), 'Approved', '--as', 'person']);
  const openDecision = json(box, box.repo, 'shout', ['person', 'An old open decision', '--decision']);
  for (let index = 0; index < 40; index += 1) json(box, box.repo, 'shout', ['app', `recent message ${index}`]);

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

