import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main as nativeTestMain } from '../../../tests/fixtures/native.js';
import { EVENT_LOG_VERSION } from '../../../../../packages/store/index.js';
import { JSON_SHAPES } from '../../../../../packages/config/index.js';
import { serveView } from '../../../src/io/commands/view.js';
import { registerProject } from '../../../../../packages/seats/index.js';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { fixtureCommandEvidence } from '../../../tests/fixtures/api.js';
import { assertRequiredShape } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';
import { runLocal } from '../../../tests/fixtures/api/milestone.js';
import { fixtureJsonStep } from '../../../tests/fixtures/api/milestone.js';
import { apiStep } from '../../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';
import { startApi } from '../../../tests/fixtures/api/milestone.js';

test('[A2,C7] a missed serve readiness deadline names the slow startup phase', async (t) => {
  const box = project();
  const phaseReachedFile = join(box.dir, 'startup-phase-reached');
  const releaseFile = join(box.dir, 'release-held-startup');
  const traceFile = join(box.dir, 'held-startup-trace.jsonl');
  rmSync(phaseReachedFile, { force: true });
  rmSync(releaseFile, { force: true });
  await assert.rejects(startApi(t, box, {
    traceStartup: true,
    traceFile,
    readinessTimeoutMs: 1_000, // budget: short deterministic observation ceiling after the held registration-start phase.
    holdPhase: 'serve-registration-start',
    phaseReachedFile,
    releaseFile,
  }), (error) => {
    assert.match(error.message, /serve readiness deadline \(1000ms\) expired/);
    assert.match(error.message, /last phase reached: serve-registration-start/);
    assert.match(error.message, /process-entry: \d+ms since child start/);
    assert.match(error.message, /cli-module-load-complete: \d+ms since child start/);
    assert.match(error.message, /cli-command-preamble-ready: \d+ms since child start/);
    assert.match(error.message, /serve-context-start: \d+ms since child start/);
    assert.match(error.message, /serve-context-ready: \d+ms since child start/,
      'the timeout names the recorded context-ready phase');
    assert.ok(error.startupPhases.length > 0, 'the timeout retains its captured phases');
    for (const { phase } of error.startupPhases) assert.ok(error.startupDiagnostics.includes(`- ${phase}:`),
      `the diagnostic lists recorded phase ${phase}`);
    assert.ok(error.message.includes(error.startupDiagnostics), 'the thrown error includes the emitted diagnostic lines');
    assert.deepEqual(error.startupPhases.map(({ phase }) => phase).slice(-1), ['serve-registration-start']);
    assert.match(error.startupDiagnostics, /last phase reached: serve-registration-start/);
    return true;
  });
});

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

    const malformedStep = await observedApiStep('reject malformed move JSON', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' }), box.env, 400);
    assert.equal(errorDocument(malformedStep).code, 'BAD_REQUEST', malformedStep.evidence);
    const oversizedStep = await observedApiStep('reject an oversized move title', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'x'.repeat(100_001) } }) }), box.env, 400);
    assert.equal(errorDocument(oversizedStep).code, 'BAD_REQUEST', oversizedStep.evidence);
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
    const emitted = (await (await apiFetch(api, `${boardPath}/events?after=${eventsStep.document.events.at(-1)?.event_id ?? 0}`)).json()).events;
    assert.ok(emitted.some(event => event.event_id === movedStep.document.event.event_id && event.event_kind === 'add'), `the committed add is in the event stream\n${movedStep.evidence}`);
    // The API runs in this process, so it has no stderr of its own to check.
  } catch (error) {
    error.message = `${error.message}\n${lastStepEvidence}`;
    throw error;
  }
});

test('[A2] moves run as the named worktree agent and requests stay visible until answered', async (t) => {
  const box = project();
  let lastStepEvidence = 'join worktree agent';
  /** Retain the last completed HTTP step if its response fails during field access. */
  async function observedApiStep(...args) {
    const result = await apiStep(...args);
    lastStepEvidence = result.evidence;
    return result;
  }
  /** Retain CLI step evidence before downstream response fields are inspected. */
  async function observedFixtureStep(...args) {
    const result = await fixtureJsonStep(...args);
    lastStepEvidence = result.evidence;
    return result;
  }
  try {
    const app = join(box.dir, 'app-1');
    box.git(box.repo, 'worktree', 'add', '-q', '-b', 'app/one', app);
    const joined = await fixtureJoin((...a) => runLocal(box, ...a), app, 'app', '--model', 'fixture-agent', '--route', 'strong');
    lastStepEvidence = fixtureCommandEvidence('join worktree agent', joined, box.env);
    assert.equal(joined.status, 0, lastStepEvidence);
    const api = await startLocalHandler(t, box);
    const boardsResponse = await observedApiStep('list registered boards', apiFetch(api, '/api/v1/boards'), box.env);
    const board = boardsResponse.document.boards.find((candidate) => candidate.root === box.repo);
    assert.ok(board, boardsResponse.evidence);
    const path = `/api/v1/boards/${board.id}`;

    const addedStep = await observedApiStep('add API move', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Agent work' } }) }), box.env);
    const added = addedStep.document;
    const claimedStep = await observedApiStep('claim API move as app-1', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {}, agent: 'app-1' }) }), box.env);
    const claimed = claimedStep.document;
    assert.ok(claimed?.event && typeof claimed.event === 'object', `claim response must contain an event\n${claimedStep.evidence}`);
    assert.equal(claimed.event.event_by, 'app-1', claimedStep.evidence);
    assert.equal(claimed.event.event_kind, 'claim', claimedStep.evidence);
    assert.equal(claimed.result.item.item_id, added.result.item.item_id, claimedStep.evidence);

    const renewedStep = await observedApiStep('renew API move as app-1', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {}, agent: 'app-1' }) }), box.env);
    const renewed = renewedStep.document;
    assert.equal(renewed.result.held, true, renewedStep.evidence);
    assert.equal(renewed.event, null, renewedStep.evidence);
    assert.equal(renewed.result.item.item_id, claimed.result.item.item_id, renewedStep.evidence);

    const escalatedStep = await observedApiStep('escalate API move as app-1', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'escalate', item: added.result.item.item_id, args: { note: 'Two attempts failed' }, agent: 'app-1' }) }), box.env);
    const escalated = escalatedStep.document;
    assert.equal(escalated.event.event_kind, 'escalate', escalatedStep.evidence);
    const eventsStep = await observedApiStep('read events after escalation', apiFetch(api, `${path}/events?after=${claimed.event.event_id}`), box.env);
    const afterEscalation = eventsStep.document.events;
    assert.deepEqual(afterEscalation.map((event) => event.event_kind), ['escalate', 'shout'], eventsStep.evidence);
    assert.equal(afterEscalation[0].event_id, escalated.event.event_id, eventsStep.evidence);

    const previousHome = process.env.PULLBOARD_HOME;
    process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
    let personView;
    let requestStep;
    try {
      registerProject(box.repo);
      personView = await serveView({ port: 0, runCommand: nativeTestMain });
      const viewUrl = new URL(personView.url);
      requestStep = await observedApiStep('create person request through the actual view', apiFetch({
        origin: viewUrl.origin,
        secret: viewUrl.searchParams.get('k'),
      }, `${path}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Approve the API row' }),
      }), box.env);
    } finally {
      try { await personView?.close(); }
      finally {
        if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
        else process.env.PULLBOARD_HOME = previousHome;
      }
    }
    const requested = requestStep.document;
    assertRequiredShape(requested, JSON_SHAPES.http.request.required, `create person request\n${requestStep.evidence}`);
    const requestId = requested.result.id;
    assert.equal(requested.event.event_by, 'person', requestStep.evidence);
    const stateStep = await observedApiStep('read request state before answering', apiFetch(api, `${path}/state`), box.env);
    const state = stateStep.document.state;
    assert.deepEqual(state.requests.map((entry) => entry.shout_id), [requestId], stateStep.evidence);
    assert.ok(!state.decisions.some((entry) => entry.shout_id === requestId), `person requests are not open decisions\n${stateStep.evidence}`);
    const inboxStep = await observedFixtureStep(box, 'read coordinator inbox', box.repo, 'inbox');
    const inbox = inboxStep.document;
    assert.equal(inbox.shouts[0].shout_id, requestId, inboxStep.evidence);
    const resumeStep = await observedFixtureStep(box, 'read coordinator resume', box.repo, 'resume');
    const resumed = resumeStep.document;
    assert.equal(resumed.requests[0].shout_id, requestId, resumeStep.evidence);

    const answerStep = await observedApiStep('answer request through API move', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'answer', item: requestId, args: { text: 'done' } }) }), box.env);
    const answered = answerStep.document;
    assert.equal(answered.event.event_kind, 'answer', answerStep.evidence);
    assert.equal(answered.event.event_by, 'coordinator', answerStep.evidence);
    const finalStateStep = await observedApiStep('confirm request disappears after answer', apiFetch(api, `${path}/state`), box.env);
    assert.deepEqual(finalStateStep.document.state.requests, [], finalStateStep.evidence);
  } catch (error) {
    error.message = `${error.message}\n${lastStepEvidence}`;
    throw error;
  }
});

