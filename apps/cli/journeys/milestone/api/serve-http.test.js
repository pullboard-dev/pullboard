import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENT_LOG_VERSION } from '../../../../../packages/store/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { assertRequiredShape } from '../../../tests/fixtures/api.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { fixtureJsonStep } from '../../../tests/fixtures/api/milestone.js';
import { apiStep } from '../../../tests/fixtures/api/milestone.js';
import { startApi } from '../../../tests/fixtures/api/milestone.js';

test('[A2] local HTTP v1 versions state and moves, authenticates, and preserves CLI refusals', async (t) => {
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
    const api = await startApi(t, box, { traceStartup: true });
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

    const missingSecretStep = await observedApiStep('read boards without the session secret', apiFetch(api, '/api/v1/boards', { noSecret: true }), box.env, 401);
    assert.equal(errorDocument(missingSecretStep).code, 'AUTH_REQUIRED', missingSecretStep.evidence);
    const wrongSecretStep = await observedApiStep('read boards with a wrong session secret', apiFetch(api, '/api/v1/boards', { headers: { 'x-pullboard-key': 'wrong-session-secret' } }), box.env, 401);
    assert.equal(errorDocument(wrongSecretStep).code, 'AUTH_REQUIRED', wrongSecretStep.evidence);
    const unknownBoardStep = await observedApiStep('read state for an unknown board', apiFetch(api, `/api/v1/boards/${'0'.repeat(32)}/state`), box.env, 404);
    assert.equal(errorDocument(unknownBoardStep).code, 'NO_BOARD', unknownBoardStep.evidence);

    const stateStep = await observedApiStep('read versioned board state', apiFetch(api, `${boardPath}/state`), box.env);
    assertRequiredShape(stateStep.document, JSON_SHAPES.http.state.required, `state response\n${stateStep.evidence}`);
    assert.equal(stateStep.document.version, 1, stateStep.evidence);
    assert.equal(stateStep.document.eventLogVersion, EVENT_LOG_VERSION, stateStep.evidence);
    const eventsStep = await observedApiStep('read versioned board events', apiFetch(api, `${boardPath}/events?after=0`), box.env);
    assertRequiredShape(eventsStep.document, JSON_SHAPES.http.events.required, `events response\n${eventsStep.evidence}`);
    assert.equal(eventsStep.document.version, 1, eventsStep.evidence);
    assert.equal(eventsStep.document.eventLogVersion, EVENT_LOG_VERSION, eventsStep.evidence);
    // The API runs in this process, so it has no stderr of its own to check.
  } catch (error) {
    error.message = `${error.message}\n${lastStepEvidence}`;
    throw error;
  }
});
