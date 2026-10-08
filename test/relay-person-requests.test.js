/** A paired browser seals person intent; only native Pullboard executes it [H12,H16,B26]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeBoardKey, seal } from '../src/seal.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';

/** Install the fixture's person session without exposing its cookie in browser diagnostics. */
async function signIn(chrome, box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: state.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true, 'the real person session is installed in the isolated browser');
}

/** Pair a real browser, then create the same transport module used by the relay cockpit. */
async function pairedTransport(chrome, box, title) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
  await chrome.evaluate(`(async () => {
    const { createTransport } = await import('/relay/client.js');
    window.__personRequestTransport = await createTransport({ onUpdate: () => {} });
    return true;
  })()`);
  return link;
}

/** Send one exact person intent through the browser transport rather than constructing a move. */
async function sendPersonIntent(chrome, board, move) {
  const path = '/api/v1/boards/' + board + '/moves';
  return chrome.evaluate('window.__personRequestTransport.request('
    + JSON.stringify(path) + ',' + JSON.stringify(move) + ')');
}

/** Poll the browser's authenticated, device-decrypted presentation for one durable receipt. */
async function waitForRequest(chrome, board, id, status, requireCoordinatorRequest = false) {
  const path = '/api/v1/boards/' + board + '/state';
  const predicate = `(() => { const row = documentValue.state?.personRequests?.find(entry => entry.id === ${JSON.stringify(id)}); return row?.status === ${JSON.stringify(status)}${requireCoordinatorRequest ? ' && Number.isSafeInteger(row.coordinatorRequest)' : ''}; })()`;
  await chrome.waitFor(`(async () => { try { const documentValue = await window.__personRequestTransport.request(${JSON.stringify(path)}); return ${predicate}; } catch { return false; } })()`);
  return chrome.evaluate('window.__personRequestTransport.request(' + JSON.stringify(path) + ')');
}

/** Add a private pending spec row without changing shared or submitted repository files. */
function addPendingSpecRow(box, id) {
  const path = join(box.root, 'SPEC.md');
  const original = readFileSync(path, 'utf8');
  assert.equal(original.includes(id + ' ['), false, 'the synthetic row id is unused');
  writeFileSync(path, original + `\n## Person request fixture\n\n- ${id} [pending, aim] Person requests wait for coordinator application. | gate: review\n`);
  return { path, original };
}

test('real paired Chrome transports one person shout, and native status makes one authored shout [H12,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const title = 'PERSON_REQUEST_SHOUT_FIXTURE';
  assert.equal((await box.cli('add', box.lane, title)).code, 0);
  await box.link();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, title);
  const move = { verb: 'shout', args: { to: 'coordinator', text: 'PERSON_REQUEST_SHOUT_LITERAL' } };
  const receipt = await sendPersonIntent(chrome, link.board, move);

  assert.equal(receipt.version, 1);
  assert.equal(receipt.result.request.status, 'waiting');
  assert.deepEqual(receipt.result.request.move, move);
  assert.equal(typeof receipt.result.request.id, 'string');
  assert.equal(box.calls.some(call => call.method === 'POST' && call.path === `/api/v1/boards/${link.board}/requests`), true,
    'the browser posts a sealed request document, not an executable engine move');
  assert.equal(box.keyInRequest(), false, 'the device key never enters an HTTP request');
  const session = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const rawResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + session.token } });
  assert.equal(rawResponse.status, 200);
  const raw = await rawResponse.json();
  assert.equal(JSON.stringify(raw).includes(move.args.text), false, 'the relay response contains opaque ciphertext rather than request text');
  const sealedRequest = raw.events.find(row => row.kind === 'request');
  assert.ok(sealedRequest && typeof sealedRequest.sealed === 'string');


  assert.equal((await box.cli('status')).code, 0, 'the next native status receives and executes the queued intent');
  const latest = await waitForRequest(chrome, link.board, receipt.result.request.id, 'done');
  const personShouts = latest.state.shouts.filter(shout => shout.shout_from === 'person' && shout.shout_text === move.args.text);
  assert.equal(personShouts.length, 1, 'the authored person shout occurs exactly once');
  const exported = (await box.cli('export')).document;
  assert.equal(exported.tables.shout.filter(shout => shout.shout_from === 'person' && shout.shout_text === move.args.text).length, 1);
});

test('real paired Chrome approval remains pending until coordinator applies and answers; invalid add keeps its CLI refusal [H12,H16,B26]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const title = 'PERSON_REQUEST_APPROVAL_FIXTURE';
  const id = 'G98';
  const row = addPendingSpecRow(box, id);
  assert.equal((await box.cli('add', box.lane, title)).code, 0);
  await box.link();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, title);

  const before = readFileSync(row.path, 'utf8');
  const approval = await sendPersonIntent(chrome, link.board, { verb: 'spec-approve', args: { ids: id } });
  assert.equal(approval.result.request.status, 'waiting');
  assert.deepEqual(approval.result.request.move, { verb: 'spec-approve', args: { ids: id } });
  assert.equal((await box.cli('status')).code, 0);
  const pendingState = await waitForRequest(chrome, link.board, approval.result.request.id, 'waiting', true);
  assert.equal(readFileSync(row.path, 'utf8'), before, 'the received approval records a row decision but does not edit SPEC.md');
  const decisionEvents = (await box.cli('export')).document.tables.event.filter(event => event.event_kind === 'row_decision' && event.event_by === 'person');
  assert.equal(decisionEvents.length, 1, 'the native row decision is attributed to the person');
  assert.equal(JSON.parse(decisionEvents[0].event_detail).record.id, id);
  const coordinatorRequest = pendingState.state.personRequests.find(entry => entry.id === approval.result.request.id).coordinatorRequest;
  const resume = (await box.cli('resume')).document;
  assert.equal(resume.requests[0].shout_id, coordinatorRequest, 'coordinator resume presents the pending repository request first');


  assert.equal((await box.cli('spec', 'apply')).code, 0, 'the coordinator applies the recorded decision locally');
  assert.match(readFileSync(row.path, 'utf8'), new RegExp(`- ${id} \\[approved, aim\\]`));
  const requestId = pendingState.state.personRequests.find(entry => entry.id === approval.result.request.id).coordinatorRequest;
  assert.equal((await box.cli('answer', String(requestId), 'done')).code, 0, 'the coordinator resolves the original request after applying it');
  const completed = await waitForRequest(chrome, link.board, approval.result.request.id, 'done');
  assert.equal(completed.state.personRequests.find(entry => entry.id === approval.result.request.id).status, 'done');

  const invalid = await sendPersonIntent(chrome, link.board, {
    verb: 'add', args: { lane: box.lane, title: 'PERSON_REQUEST_INVALID_SPEC', specs: 'G999' },
  });
  assert.equal(invalid.result.request.status, 'waiting');
  assert.equal((await box.cli('status')).code, 0, 'native CLI status records the exact command refusal without creating an item');
  const afterInvalid = (await box.cli('export')).document;
  assert.equal(afterInvalid.tables.item.some(item => item.item_title === 'PERSON_REQUEST_INVALID_SPEC'), false, 'the native CLI refuses unknown specs before an ordinary add move');
  const refused = await waitForRequest(chrome, link.board, invalid.result.request.id, 'refused');
  const refusal = refused.state.personRequests.find(entry => entry.id === invalid.result.request.id).error;
  assert.equal(refusal.code, 'UNKNOWN_SPEC');
  assert.equal(refusal.message, 'G999 is not in SPEC.md');
  const terminalRefusal = await box.cli('add', box.lane, 'PERSON_REQUEST_INVALID_SPEC', '--specs', 'G999');
  assert.equal(terminalRefusal.code, 1);
  assert.deepEqual(refusal, terminalRefusal.document.error, 'the request carries the same complete CLI refusal document');
  const local = (await box.cli('export')).document;
  assert.equal(local.tables.item.some(item => item.item_title === 'PERSON_REQUEST_INVALID_SPEC'), false);
  assert.equal(local.tables.event.some(event => event.event_kind === 'row_decision' && JSON.parse(event.event_detail).record.id === 'G999'), false);
});

test('an agent-sealed row approval is refused before any row receipt or spec edit [H12,H16,B26]', async t => {
  const box = await relayClientFixture(t);
  const id = 'G97';
  const row = addPendingSpecRow(box, id);
  const before = readFileSync(row.path, 'utf8');
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const personToken = link.token;
  const tokenResponse = await fetch(box.origin + '/auth/tokens', {
    method: 'POST', headers: { authorization: 'Bearer ' + personToken, 'content-type': 'application/json' },
    body: JSON.stringify({ board: link.board, agent: 'request-fixture-agent' }),
  });
  assert.equal(tokenResponse.status, 201, 'the signed-in person can issue a scoped agent token');
  const agentToken = (await tokenResponse.json()).token;
  const snapshotResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + personToken },
  });
  assert.equal(snapshotResponse.status, 200);
  const sequence = (await snapshotResponse.json()).state.sequence + 1;
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const document = { version: 1, type: 'person-request', id: randomUUID(), move: { verb: 'spec-approve', args: { ids: id } } };
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(document)), {
    boardId: link.board, kind: 'request', sequence,
  })).toString('base64url');
  const uploaded = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', {
    method: 'POST', headers: { authorization: 'Bearer ' + agentToken, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence, sealed }),
  });
  assert.equal(uploaded.status, 200, 'the opaque journal accepts authenticated ciphertext without interpreting it');
  assert.equal((await box.cli('status')).code, 0, 'native replay records the sender refusal');
  const exported = (await box.cli('export')).document;
  const receipts = JSON.parse(exported.tables.board_meta.find(row => row.meta_key === 'relay_person_requests').meta_value);
  const refused = receipts.find(entry => entry.id === document.id);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.error.code, 'RELAY_PERSON_ONLY');
  assert.equal(exported.tables.event.some(event => event.event_kind === 'row_decision' && JSON.parse(event.event_detail).record.id === id), false);
  assert.equal(readFileSync(row.path, 'utf8'), before, 'agent intent cannot create a person receipt or change SPEC.md');
});

test('coordinator decline resolves a paired approval request with a reason and leaves repo files unchanged [H12,H16,B26]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const row = addPendingSpecRow(box, 'G96');
  const before = readFileSync(row.path, 'utf8');
  const title = 'PERSON_REQUEST_DECLINE_FIXTURE';
  assert.equal((await box.cli('add', box.lane, title)).code, 0);
  await box.link();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, title);
  const queued = await sendPersonIntent(chrome, link.board, { verb: 'spec-approve', args: { ids: 'G96' } });
  assert.equal((await box.cli('status')).code, 0);
  const statePath = '/api/v1/boards/' + link.board + '/state';
  const pending = (await chrome.evaluate('window.__personRequestTransport.request(' + JSON.stringify(statePath) + ')')).state.personRequests.find(record => record.id === queued.result.request.id);
  assert.equal(pending.status, 'waiting');
  assert.ok(Number.isSafeInteger(pending.coordinatorRequest));
  const missingReason = await box.cli('answer', String(pending.coordinatorRequest), 'declined');
  assert.equal(missingReason.code, 1);
  assert.equal(missingReason.document.error.code, 'REQUEST_OUTCOME');
  const reason = 'Waiting for a revised requirement';
  assert.equal((await box.cli('answer', String(pending.coordinatorRequest), 'declined ' + reason)).code, 0);
  const completed = (await chrome.evaluate('window.__personRequestTransport.request(' + JSON.stringify(statePath) + ')')).state.personRequests.find(record => record.id === queued.result.request.id);
  assert.equal(completed.status, 'refused');
  assert.deepEqual(completed.error, { code: 'REQUEST_DECLINED', message: reason, next: 'Read the coordinator reason and send a revised request from the view.' });
  assert.equal(readFileSync(row.path, 'utf8'), before, 'declining the repository request does not edit any row');
  assert.deepEqual((await box.cli('resume')).document.requests, [], 'the declined request leaves the open coordinator queue');
});
