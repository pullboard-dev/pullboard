// pullboard: browser
/** @pullboard-test-gui */
/** Real native approvals fail with their exact request id when expired or unreachable, and elapsed fixture time never manufactures an expiry [H15,H12,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';
import { closeCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../packages/board/tests/fixtures/cell-board.js';
import {
  nativeRevocations,
  pairChromePhone,
  waitFor,
} from './fixtures/relay-phone-fixture.js';
import { findChromeExecutable } from '../../cli/tests/fixtures/relay/browser.js';

/**
 * Move this process's wall clock forward by `ms` for the rest of the test, so native and relay both see that much
 * elapsed work with no real wait; the clock keeps running and the shift is undone when the test ends.
 * Why: the claim is that the relay clock follows elapsed time, which a 31 s sleep proved only by being slow.
 */
function elapseClock(t, ms) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  t.after(() => { Date.now = realNow; });
}

/** Issue a real board-scoped token through the fixture's persistent relay-auth database. */
async function issueToken(box, label) {
  const link = box.readLink();
  const response = await fetch(box.origin + '/auth/tokens', { method: 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'content-type': 'application/json' },
    body: JSON.stringify({ board: link.board, agent: label }) });
  assert.equal(response.status, 201, 'the real board delegate mints the revocation target');
  return response.json();
}

/** Start a native revocation and recover only the immutable request identity from actual HTTP. */
async function startRevocation(box, revocations, id) {
  const before = box.server.transit.length;
  const done = revocations.start(id);
  const posted = await waitFor(() => box.server.transit.slice(before).find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'),
    'the native revocation posts its sealed request to the real relay');
  const context = JSON.parse(posted.request.toString('utf8')).context;
  assert.equal(context.target, id);
  assert.ok(context.id, 'the actual HTTP request has its own approval id');
  return { command: { done }, context };
}

/** Tap the actual phone card and wait for its native command to finish once. */
async function approve(chrome, requestId, command) {
  await assert.doesNotReject(() => chrome.waitFor(`document.querySelector('#phone-approve-${requestId}') !== null`),
    'the delivered approval becomes a visible card');
  await chrome.stable(`(() => {
    window.__approvalDiagnosticRequest = ${JSON.stringify(requestId)};
    window.__approvalRelayResponses = [];
    window.__approvalLastActionResponse = null;
  })()`);
  await chrome.click(`document.querySelector('#phone-approve-${requestId}')`);
  const result = await command.done;
  assert.equal(result.code, 0, 'one real phone tap completes its native approval command');
  await waitForApprovalCardRemoval(chrome, requestId);
  return result;
}

/** Capture a removal failure using the original browser budget unless a diagnostic fixture supplies one. */
async function waitForApprovalCardRemoval(chrome, requestId, timeoutMs) {
  try {
    await chrome.waitFor(`document.querySelector('#phone-approve-${requestId}') === null`, timeoutMs);
  } catch (error) {
    let page;
    try {
      const relaySnapshot = await chrome.stable(`(() => {
        const lastRelayResponses = (window.__approvalRelayResponses ?? []).slice(-8).map(entry => ({ ...entry }));
        const lastActionResponse = window.__approvalLastActionResponse ? { ...window.__approvalLastActionResponse } : null;
        window.__approvalFailureRelayResponses = lastRelayResponses;
        return { observedAt: new Date().toISOString(), entries: lastRelayResponses, lastActionResponse };
      })()`);
      const observation = await chrome.stable(`(() => {
        const card = document.querySelector('.phone-approval[data-request="${requestId}"]');
        const button = card?.querySelector('button');
        return {
          capturedAt: new Date().toISOString(), capturedAfter: 'the existing card-removal wait rejected',
          elapsedMs: Math.round(performance.now() - (window.__approvalObservationStartedAt ?? performance.now())),
          card: { present: Boolean(card), requestMatches: card?.dataset.request === ${JSON.stringify(requestId)},
            buttonText: (button?.textContent ?? '').slice(0, 80) || null, buttonDisabled: button?.disabled ?? null },
          cardRefusal: (card?.querySelector('p')?.textContent ?? '').startsWith('Approval failed: ')
            ? card.querySelector('p').textContent.slice(0, 320) : null,
          panelError: (document.querySelector('#phone-approvals')?.getAttribute('data-error') ?? '').slice(0, 240) || null,
          refusalNotice: (document.querySelector('#relay-notice')?.textContent ?? '').slice(0, 240) || null,
        };
      })()`);
      const targetAction = relaySnapshot.lastActionResponse?.matchesDiagnosticRequest === true
        ? relaySnapshot.lastActionResponse : null;
      const lastRelayResponse = relaySnapshot.entries.at(-1) ?? null;
      page = { ...observation, relayResponsesObservedAt: relaySnapshot.observedAt,
        lastRelayResponses: relaySnapshot.entries,
        targetResponse: targetAction ? `${targetAction.route}:${targetAction.status}:matched` : 'none',
        lastRelayResponse: lastRelayResponse ? `${lastRelayResponse.route}:${lastRelayResponse.status}:matched` : 'none' };
    } catch (captureError) {
      page = { captureError: String(captureError?.message ?? captureError).slice(0, 240) };
    }
    const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,64}$/u.test(error.code) ? error.code : 'none';
    const captureSummary = page.captureError ? 'captureError=true' : `captureError=false; cardPresent=${page.card?.present === true}; requestMatches=${page.card?.requestMatches === true}; targetResponse=${page.targetResponse ?? 'none'}; lastRelayResponse=${page.lastRelayResponse ?? 'none'}`;
    error.message = `${String(error?.message ?? error).slice(0, 500)}; ROOT-CAUSE STATUS: NOT PROVEN; capture follows the original wait failure and contains no response bodies; waitCode=${errorCode}; ${captureSummary}; page=${JSON.stringify(page)}`;
    throw error;
  }
}

test('relay.approval-revoke.expired-and-unreachable-approvals-fail-with: expired and unreachable approvals fail with their exact request id [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  await pairChromePhone(box, t);
  const native = nativeRevocations(box, t);
  const token = await issueToken(box, 'approval-expired');
  const expiry = await startRevocation(box, native, token.id);
  box.server.advance(1);
  const expired = await expiry.command.done;
  box.server.advance(0);
  assert.equal(expired.code, 1);
  assert.equal(expired.error.code, 'PHONE_APPROVAL_EXPIRED');
  assert.ok(expired.error.message.includes(expiry.context.id), 'expiry retains the original approval identity');
  const unreachable = await startRevocation(box, native, token.id);
  await box.server.stopRelay();
  const offline = await unreachable.command.done;
  assert.equal(offline.code, 1);
  assert.equal(offline.error.code, 'RELAY_UNAVAILABLE');
  assert.ok(offline.error.message.includes(unreachable.context.id), 'unreachable polling retains the approval identity');
});

test('relay.approval-revoke.elapsed-fixture-wall-time-never-manufactures: elapsed fixture wall time never manufactures an approval expiry refusal [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayDirectFixture(t, { openCellBoard, closeCellBoard });
  const { chrome } = await pairChromePhone(box, t);
  const native = nativeRevocations(box, t);
  const token = await issueToken(box, 'approval-elapsed-clock');
  // The old frozen relay clock refuses a real native expiry after thirty seconds of elapsed work.
  elapseClock(t, 31_000);
  const request = await startRevocation(box, native, token.id);
  const posted = box.server.transit.find(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'
    && JSON.parse(record.request.toString('utf8')).context.id === request.context.id);
  assert.equal(JSON.parse(posted.response.toString('utf8')).approval?.context.id, request.context.id,
    'the live fixture clock accepts the actual native ten-minute expiry after elapsed work');
  await approve(chrome, request.context.id, request.command);
});
