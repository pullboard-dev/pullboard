/** A paired person can use narrow CLI actions; agents cannot impersonate those actions [H12,H16,B26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { prepareEngineMove } from '../src/engine.js';
import { openBoard, closeBoard } from '../src/board.js';
import { executeMove } from '../src/api.js';
import { main } from '../src/cli.js';
import { decodeBoardKey, seal } from '../src/seal.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { findChromeExecutable, relayWorkBudgetMs, startChrome } from './relay-browser-fixture.js';
import { assertSnapshotCheckpoints, cliChildDeadlineMs, relayClientFixture } from './relay-client-fixture.js';

/** Record the real phase and wait budget for a late-snapshot failure without changing either wait. */
function lateSnapshotTiming(t) {
  const phases = [];
  const testStartedAt = performance.now();
  let active = null;
  /** Finish the active phase and retain only timing metadata. */
  function finish() {
    if (!active) return;
    phases.push({ phase: active.phase, waitMs: active.waitMs, elapsedMs: Math.round(performance.now() - active.startedAt) });
    active = null;
  }
  t.after(() => {
    const current = active && { phase: active.phase, waitMs: active.waitMs,
      elapsedMs: Math.round(performance.now() - active.startedAt) };
    t.diagnostic('late snapshot phase timing: ' + JSON.stringify({
      plannedSnapshotDelayMs: 8000,
      activePhase: current?.phase ?? null,
      lastCompletedPhase: phases.at(-1)?.phase ?? null,
      elapsedMs: Math.round(performance.now() - testStartedAt),
      waitMs: current?.waitMs ?? phases.at(-1)?.waitMs ?? null,
      loadavg: loadavg(),
      phases: current ? [...phases, current] : phases,
    }));
  });
  return {
    /** Emit sanitized timing before Node runs potentially blocking teardown hooks. */
    reportFailure(error) {
      const current = active && { phase: active.phase, waitMs: active.waitMs,
        elapsedMs: Math.round(performance.now() - active.startedAt) };
      process.stderr.write('[late-snapshot-timing] ' + JSON.stringify({
        outcome: 'failed', failureType: error?.name ?? 'Error',
        plannedSnapshotDelayMs: 8000,
        activePhase: current?.phase ?? null,
        lastCompletedPhase: phases.at(-1)?.phase ?? null,
        elapsedMs: Math.round(performance.now() - testStartedAt),
        waitMs: current?.waitMs ?? phases.at(-1)?.waitMs ?? null,
        loadavg: loadavg(),
        phases: current ? [...phases, current] : phases,
      }) + '\n');
    },
    /** Begin a named operation with the exact existing operation bound, without extending it. */
    begin(phase, waitMs) { finish(); active = { phase, waitMs, startedAt: performance.now() }; },
    /** Record the child's final work-derived bound without changing its execution. */
    updateWait(waitMs) { if (active) active.waitMs = waitMs; },
    finish,
  };
}

/** Install only the private fixture's person cookie in the real browser. */
async function signIn(chrome, box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true);
}

/** Pair a real browser and initialize the same transport used by the relay cockpit. */
async function pairedTransport(chrome, box, title, timing = null) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = readFileSync(box.keyFile, 'utf8').trim();
  timing?.begin('person session sign-in', relayWorkBudgetMs());
  await signIn(chrome, box);
  timing?.finish();
  timing?.begin('Chrome navigation', relayWorkBudgetMs());
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + key);
  timing?.finish();
  timing?.begin('page readiness', relayWorkBudgetMs());
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
  timing?.finish();
  timing?.begin('page transport readiness', relayWorkBudgetMs());
  await chrome.waitFor('typeof transport?.request === "function"', relayWorkBudgetMs(), 'real page transport ready');
  assert.equal(await chrome.evaluate(`(() => { window.__personActionTransport = transport;
    return window.__personActionTransport === transport; })()`, 'use real paired person transport'), true,
    'fixture commands use the page-owned transport and its single stream queue');
  timing?.finish();
  return link;
}

/** Submit literal person intent through the browser-owned transport. */
async function personAction(chrome, board, move) {
  const task = await chrome.startTask('window.__personActionTransport.request('
    + JSON.stringify('/api/v1/boards/' + board + '/moves') + ',' + JSON.stringify(move) + ')', 'send person action');
  return chrome.pollTask(task, relayWorkBudgetMs(), 'send person action');
}

/** Poll checkpoint completion separately from CDP's bounded evaluation deadline. */
async function waitRequest(chrome, board, id, status) {
  const path = '/api/v1/boards/' + board + '/state';
  const predicate = `value.state?.personRequests?.some(entry => entry.id === ${JSON.stringify(id)} && entry.status === ${JSON.stringify(status)})`;
  // Share the native command, bounded snapshot attempts and scheduling allowance.
  const task = await chrome.startTask(`(async () => {
      const deadline = Date.now() + ${relayWorkBudgetMs()};
      while (Date.now() < deadline) {
        try {
          const value = await window.__personActionTransport.request(${JSON.stringify(path)});
          if (${predicate}) return value;
        } catch { /* A checkpoint still being uploaded leaves the request waiting. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('The native request status did not reach the paired browser.');
    })()`, 'wait for native person request status');
  return chrome.pollTask(task, relayWorkBudgetMs() + relayWorkBudgetMs(0), 'wait for native person request status');
}

/** Read the final relay state without holding Runtime.evaluate open across network work. */
async function finalState(chrome, board) {
  const task = await chrome.startTask('window.__personActionTransport.request('
    + JSON.stringify('/api/v1/boards/' + board + '/state') + ')', 'read final person-action state');
  return chrome.pollTask(task, relayWorkBudgetMs(), 'read final person-action state');
}

test('real paired person adds, answers a person decision, and holds then releases a lane [H12,H16,B26]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const title = 'PERSON_ACTION_ITEM_FIXTURE';
  const decisionText = 'PERSON_ACTION_DECISION_FIXTURE';
  assert.equal((await box.cli('add', box.lane, 'PERSON_ACTION_BROWSER_READY')).code, 0);
  const asked = await box.cli('shout', 'person', decisionText, '--decision');
  assert.equal(asked.code, 0);
  const decision = asked.document.id;
  assert.ok(Number.isSafeInteger(decision));
  await box.link();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, 'PERSON_ACTION_BROWSER_READY');

  const added = await personAction(chrome, link.board, {
    verb: 'add', args: { lane: box.lane, title },
  });
  assert.equal(added.result.request.status, 'waiting');
  assert.equal((await box.cli('status')).code, 0);
  await waitRequest(chrome, link.board, added.result.request.id, 'done');
  let exported = (await box.cli('export')).document;
  const item = exported.tables.item.find(row => row.item_title === title);
  assert.ok(item, 'the actual CLI created the requested item');
  assert.equal(item.item_created_by, 'person');
  const addEvent = exported.tables.event.find(row => row.event_kind === 'add' && row.item_id === item.item_id);
  assert.equal(addEvent.event_by, 'person');

  const answered = await personAction(chrome, link.board, {
    verb: 'answer', item: decision, args: { text: 'PERSON_ACTION_ANSWER_FIXTURE' },
  });
  assert.equal(answered.result.request.status, 'waiting');
  assert.equal((await box.cli('status')).code, 0);
  await waitRequest(chrome, link.board, answered.result.request.id, 'done');
  exported = (await box.cli('export')).document;
  const answer = exported.tables.event.find(row => row.event_kind === 'answer' && row.event_by === 'person');
  assert.ok(answer);
  assert.equal(JSON.parse(answer.event_detail).channel, 'view');

  const held = await personAction(chrome, link.board, {
    verb: 'hold', args: { lane: box.lane, reason: 'PERSON_ACTION_HOLD_FIXTURE' },
  });
  assert.equal(held.result.request.status, 'waiting');
  assert.equal((await box.cli('status')).code, 0);
  await waitRequest(chrome, link.board, held.result.request.id, 'done');
  exported = (await box.cli('export')).document;
  assert.deepEqual(exported.tables.hold.map(row => [row.hold_lane, row.hold_by]), [[box.lane, 'person']]);
  const holdEvent = exported.tables.event.find(row => row.event_kind === 'hold' && JSON.parse(row.event_detail).reason === 'PERSON_ACTION_HOLD_FIXTURE');
  assert.equal(holdEvent.event_by, 'person');

  const released = await personAction(chrome, link.board, { verb: 'hold', args: { lane: box.lane, off: true } });
  assert.equal(released.result.request.status, 'waiting');
  assert.equal((await box.cli('status')).code, 0);
  await waitRequest(chrome, link.board, released.result.request.id, 'done');
  exported = (await box.cli('export')).document;
  assert.equal(exported.tables.hold.some(row => row.hold_lane === box.lane), false);
  const unholdEvent = exported.tables.event.find(row => row.event_kind === 'unhold' && JSON.parse(row.event_detail).lane === box.lane);
  assert.equal(unholdEvent.event_by, 'person');
  const actionEvents = exported.tables.event.filter(row => ['add', 'answer', 'hold', 'unhold'].includes(row.event_kind) && row.event_by === 'person');
  assert.deepEqual(actionEvents.map(row => row.event_kind), ['add', 'answer', 'hold', 'unhold']);

  const invalid = await personAction(chrome, link.board, {
    verb: 'hold', args: { lane: 'PERSON_ACTION_NO_SUCH_LANE', reason: 'must refuse' },
  });
  assert.equal((await box.cli('status')).code, 0);
  await waitRequest(chrome, link.board, invalid.result.request.id, 'refused');
  const state = await finalState(chrome, link.board);
  const refusal = state.state.personRequests.find(row => row.id === invalid.result.request.id).error;
  assert.equal(refusal.code, 'NO_LANE');
  exported = (await box.cli('export')).document;
  assert.equal(exported.tables.event.some(row => row.event_kind === 'hold' && JSON.parse(row.event_detail).lane === 'PERSON_ACTION_NO_SUCH_LANE'), false);
  const brief = 'Files:\n- ../foreign.js\nTest:\n- Keep the file in its own lane';
  const foreign = await personAction(chrome, link.board, { verb: 'add', args: { lane: box.lane, title: 'PERSON_ACTION_FOREIGN_BRIEF', brief } });
  assert.equal((await box.cli('status')).code, 0);
  const rejected = (await finalState(chrome, link.board)).state.personRequests.find(row => row.id === foreign.result.request.id);
  assert.equal(rejected.status, 'refused');
  assert.equal(rejected.error.code, 'BRIEF_LANE');
  const terminal = await box.cli('add', box.lane, 'PERSON_ACTION_FOREIGN_BRIEF', '--brief', brief);
  assert.equal(terminal.code, 1);
  assert.deepEqual(rejected.error, terminal.document.error, 'lane preflight retains the ordinary CLI refusal and repair');

});

test('a person action completes with late native snapshots after 8 seconds [H12,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const timing = lateSnapshotTiming(t);
  try {
    timing.begin('fixture setup and item creation', '4 serial private CLI children; each has the existing 55,000 ms child bound');
    const box = await relayClientFixture(t);
    const title = 'PERSON_ACTION_LATE_SNAPSHOT_READY';
    assert.equal((await box.cli('add', box.lane, title)).code, 0);
    timing.finish();
    timing.begin('relay link', cliChildDeadlineMs(3));
    await box.link();
    timing.finish();
    timing.begin('Chrome startup', relayWorkBudgetMs(2));
    const chrome = await startChrome();
    t.after(() => chrome.close());
    timing.finish();
    const link = await pairedTransport(chrome, box, title, timing);
    timing.begin('person action', relayWorkBudgetMs());
    const action = await personAction(chrome, link.board, {
      verb: 'shout', args: { to: 'coordinator', text: 'PERSON_ACTION_LATE_SNAPSHOT' },
    });
    assert.equal(action.result.request.status, 'waiting');
    timing.finish();

    const delayedBefore = box.snapshotWriteDelays().length;
    const snapshotRecordsBefore = box.snapshotWriteRecords().length;
    timing.begin('native status child and delayed checkpoint uploads', `initial child bound ${cliChildDeadlineMs(3)} ms for 3 uploads`);
    box.delaySnapshotWrites(8000);
    const native = box.cliWithSnapshotUploads(3, 'status').then(result => ({ result }), error => ({ error }));
    const status = await native;
    box.delaySnapshotWrites(0);
    const observedUploads = box.snapshotWriteRecords().length - snapshotRecordsBefore;
    timing.updateWait(`initial ${cliChildDeadlineMs(3)} ms; current upload-derived bound ${cliChildDeadlineMs(Math.max(3, observedUploads))} ms for ${observedUploads} observed uploads`);
    assert.equal(status.error, undefined, 'the real native CLI completes within its upload-derived fixture budget');
    assert.equal(status.result.code, 0, 'the real native CLI reports success');
    const delays = box.snapshotWriteDelays().slice(delayedBefore);
    assertSnapshotCheckpoints(status.result.snapshotTrace, 3);
    assert.ok(delays.every(delay => delay >= 7900), 'the relay delayed every native snapshot by 8 seconds');
    timing.finish();
    timing.begin('paired-browser request completion poll', '85,000 ms in-page poll; 110,000 ms outer CDP task bound');
    const completed = await waitRequest(chrome, link.board, action.result.request.id, 'done');
    assert.equal(completed.state.personRequests.find(row => row.id === action.result.request.id).status, 'done');
    timing.finish();
    timing.begin('final export', cliChildDeadlineMs(3));
    const exported = (await box.cli('export')).document;
    assert.equal(exported.tables.shout.filter(row => row.shout_text === 'PERSON_ACTION_LATE_SNAPSHOT').length, 1);
    timing.finish();
  } catch (error) {
    timing.reportFailure(error);
    throw error;
  }
});

test('local view attribution is person-only and an agent token cannot seal person-attributed holds [H12,H16,B26]', async t => {
  const box = await relayClientFixture(t);
  const localHold = await executeMove(box.root, { verb: 'hold', args: { lane: box.lane, reason: 'LOCAL_PERSON_HOLD_FIXTURE' } }, main);
  assert.equal(localHold.status, 200);
  assert.equal(localHold.body.event.event_by, 'person');
  assert.equal(JSON.parse(localHold.body.event.event_detail).channel, 'view');
  const localRelease = await executeMove(box.root, { verb: 'hold', args: { lane: box.lane, off: true } }, main);
  assert.equal(localRelease.status, 200);
  assert.equal(localRelease.body.event.event_by, 'person');
  assert.equal(JSON.parse(localRelease.body.event.event_detail).channel, 'view');

  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const tokenResponse = await fetch(box.origin + '/auth/tokens', {
    method: 'POST', headers: { authorization: 'Bearer ' + link.token, 'content-type': 'application/json' },
    body: JSON.stringify({ board: link.board, agent: 'person-action-agent' }),
  });
  assert.equal(tokenResponse.status, 201);
  const agentToken = (await tokenResponse.json()).token;
  const stateResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stateResponse.status, 200);
  let sequence = (await stateResponse.json()).state.sequence;
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let attempted;
  try {
    attempted = [
      prepareEngineMove(board, 'holdLane', [box.lane, { agentId: 'coordinator', asPerson: true, reason: 'forged person hold' }]),
      prepareEngineMove(board, 'releaseLane', [box.lane, { agentId: 'coordinator', asPerson: true }]),
    ];
  } finally { closeBoard(board); }
  for (const move of attempted) {
    sequence += 1;
    const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
    const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(move)), { boardId: link.board, kind: 'move', sequence })).toString('base64url');
    const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
      method: 'POST', headers: { authorization: 'Bearer ' + agentToken, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
      body: JSON.stringify({ sequence, sealed }),
    });
    assert.equal(response.status, 200, 'the relay stores the opaque agent-authenticated envelope');
  }
  assert.equal((await box.cli('status')).code, 0, 'native replay records both sender refusals');
  const exported = (await box.cli('export')).document;
  const refusals = exported.tables.event.filter(row => row.event_kind === 'relay_refused' && row.event_by === 'person-action-agent');
  assert.deepEqual(refusals.map(row => JSON.parse(row.event_detail).code), ['RELAY_PERSON_ONLY', 'RELAY_PERSON_ONLY']);
  assert.equal(exported.tables.event.some(row => ['hold', 'unhold'].includes(row.event_kind)
    && JSON.parse(row.event_detail).reason === 'forged person hold'), false);
  assert.equal(exported.tables.hold.some(row => row.hold_lane === box.lane && row.hold_reason === 'forged person hold'), false);
  assert.ok(Number.isSafeInteger(ENGINE_VERSION), 'the test follows the current engine envelope without pinning a version');
});
