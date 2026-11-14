import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { fixtureCommandEvidence } from '../../../tests/fixtures/api.js';
import { assertRequiredShape } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { runLocal } from '../../../tests/fixtures/api/milestone.js';
import { fixtureJsonStep } from '../../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';
import { apiStep } from '../../../tests/fixtures/api/milestone.js';

test('[A2] local HTTP v1 moves reject malformed requests and preserve CLI refusals', async (t) => {
  const box = project();
  let lastStepEvidence = 'create local API';
  /** Retain the last completed HTTP step if downstream response inspection fails. */
  async function observedApiStep(...args) {
    const result = await apiStep(...args);
    lastStepEvidence = result.evidence;
    return result;
  }
  /** Retain CLI step evidence before downstream JSON inspection. */
  async function observedFixtureStep(box, step, cwd, command, args = [], expectedStatus = 0) {
    return await fixtureJsonStep(box, step, cwd, command, args, expectedStatus,
      (evidence) => { lastStepEvidence = evidence; });
  }
  try {
    const api = await startLocalHandler(t, box, { personChannel: 'api' });
    /** Validate one captured HTTP refusal while keeping its originating step and response in every failure. */
    function errorDocument(result) {
      assertRequiredShape(result.document, JSON_SHAPES.error.required, `HTTP refusal\n${result.evidence}`);
      assertRequiredShape(result.document.error, JSON_SHAPES.errorFields, `HTTP refusal fields\n${result.evidence}`);
      return result.document.error;
    }

    const boardsStep = await observedApiStep('list registered boards', apiFetch(api, '/api/v1/boards'), box.env);
    assertRequiredShape(boardsStep.document, JSON_SHAPES.http.boards.required, `boards response\n${boardsStep.evidence}`);
    const board = boardsStep.document.boards.find((candidate) => candidate.root === box.repo);
    assert.ok(board?.id, boardsStep.evidence);
    const boardPath = `/api/v1/boards/${board.id}`;

    const priorEvents = (await (await apiFetch(api, `${boardPath}/events?after=0`)).json()).events;

    const malformedStep = await observedApiStep('reject malformed move JSON', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' }), box.env, 400);
    assert.equal(errorDocument(malformedStep).code, 'BAD_REQUEST', malformedStep.evidence);
    const oversizedStep = await observedApiStep('reject an oversized move title', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'x'.repeat(100_001) } }) }), box.env, 400);
    // a06f1f5cea: a move over the relay body limit gets a size refusal, not a malformed-request one.
    assert.equal(errorDocument(oversizedStep).code, 'MOVE_TOO_LARGE', oversizedStep.evidence);
    const unknownVerbStep = await observedApiStep('reject an unknown move verb', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'pretend', args: {} }) }), box.env, 400);
    assert.equal(errorDocument(unknownVerbStep).code, 'BAD_REQUEST', unknownVerbStep.evidence);
    const unknownArgumentStep = await observedApiStep('reject an unknown move argument', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Ignored', extra: true } }) }), box.env, 400);
    assert.equal(errorDocument(unknownArgumentStep).code, 'BAD_REQUEST', unknownArgumentStep.evidence);

    const cliClaimStep = await observedFixtureStep(box, 'claim an unknown item through the CLI', box.repo, 'claim', ['999'], 1);
    const cliRefusal = cliClaimStep.document.error;
    assertRequiredShape(cliRefusal, JSON_SHAPES.errorFields, `CLI claim refusal\n${cliClaimStep.evidence}`);
    const httpClaimStep = await observedApiStep('claim an unknown item through HTTP', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'claim', item: 999, args: {} }) }), box.env, 409);
    assert.deepEqual(errorDocument(httpClaimStep), cliRefusal, `${httpClaimStep.evidence}\nCLI evidence:\n${cliClaimStep.evidence}`);

    const cliNextRun = await runLocal(box, box.repo, 'next', '--json');
    const cliNextStep = { evidence: fixtureCommandEvidence('request available work through the CLI', cliNextRun, box.env) };
    const noWork = JSON.parse(cliNextRun.stdout);
    assert.deepEqual([cliNextRun.status, cliNextRun.stderr, noWork.version, noWork.item, noWork.next, Array.isArray(noWork.reasons)], [0, '', 1, null, 'nothing for this seat: end your turn', true], cliNextStep.evidence);
    const httpNextStep = await observedApiStep('request available work through HTTP', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {} }) }), box.env);
    assert.deepEqual(httpNextStep.document, { version: 1, event: null, result: noWork }, `${httpNextStep.evidence}\nCLI evidence:\n${cliNextStep.evidence}`);

    const cliVerifyStep = await observedFixtureStep(box, 'verify an unknown item through the CLI', box.repo, 'verify', ['999', 'accept', '--as', 'coordinator', '--note', 'checked the API'], 1);
    const verifierRefusal = cliVerifyStep.document.error;
    assertRequiredShape(verifierRefusal, JSON_SHAPES.errorFields, `CLI verify refusal\n${cliVerifyStep.evidence}`);
    const httpVerifyStep = await observedApiStep('verify an unknown item through HTTP', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'verify', item: 999, args: { decision: 'accept', as: 'coordinator', note: 'checked the API' } }) }), box.env, 409);
    assert.deepEqual(errorDocument(httpVerifyStep), verifierRefusal, `${httpVerifyStep.evidence}\nCLI evidence:\n${cliVerifyStep.evidence}`);

    const movedStep = await observedApiStep('add a move with a dash-prefixed title', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: '--help' } }) }), box.env);
    assertRequiredShape(movedStep.document, JSON_SHAPES.http.move.required, `move response\n${movedStep.evidence}`);
    assert.ok(movedStep.document.result?.item && typeof movedStep.document.result.item === 'object',
      `add response must include its nested item\n${movedStep.evidence}`);
    assert.equal(movedStep.document.result.item.item_title, '--help', movedStep.evidence);
    assert.equal(movedStep.document.event.event_kind, 'add', movedStep.evidence);
    const emitted = (await (await apiFetch(api, `${boardPath}/events?after=${priorEvents.at(-1)?.event_id ?? 0}`)).json()).events;
    assert.ok(emitted.some(event => event.event_id === movedStep.document.event.event_id && event.event_kind === 'add'), `the committed add is in the event stream\n${movedStep.evidence}`);
    // The API runs in this process, so it has no stderr of its own to check.
  } catch (error) {
    error.message = `${error.message}\n${lastStepEvidence}`;
    throw error;
  }
});
