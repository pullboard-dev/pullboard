import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main as nativeTestMain } from '../../../tests/fixtures/native.js';
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
