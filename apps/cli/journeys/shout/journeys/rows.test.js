// pullboard: browser
/** @pullboard-test-gui */
/** The view's main journeys as real-input scenarios in Chrome [N26], and the two-home hosted journey through the real view, relay, browser client and item API [N40]. */

import assert from 'node:assert/strict';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  waitFor,
  journeySidebarReady,
  journeyExpectedListAnswer,
  observeJourneyRows,
} from '../../../tests/fixtures/cockpit/journey/every.js';

test('the hosted journey names what it saw when a board row never arrives [N40]', async () => {
  const seen = {
    rows: [
      { kind: 'repo', label: 'fixture/repository', detail: 'linked · 1 item open', text: 'fixture/repository · linked · 1 item open' },
      { kind: 'repo-error', label: 'unlisted-board-sentinel', text: 'unlisted-board-sentinel: Sign in again to show local boards token=secret-token key=private-key person_id=person-987 path=/Users/private/project https://private.example/path?q=secret#person' },
      { kind: 'empty', label: '', text: 'None yet.' },
      { kind: 'group', label: 'private-group-name', detail: '2 repos', text: 'private-group-name 2 repos' },
      ...Array.from({ length: 14 }, (_, index) => ({ kind: 'repo', label: `unknown-${index}`, detail: 'this computer · 1 item open', text: `unknown-${index} · this computer · 1 item open` })),
    ],
    unknownRowsPresent: true,
    projects: [
      { name: 'fixture/repository', source: 'relay', ok: true, errorPresent: false },
      { name: 'local-machine-b', source: 'local', ok: true, errorPresent: false },
      { name: 'unlisted-board-sentinel', source: 'local', ok: false, errorPresent: true },
    ],
    unknownProjectsPresent: true,
    localSessionPresent: true,
    localReadPresent: true,
    localOriginIsFixture: true,
    transportPresent: true,
    transportLoading: false,
    transportLoadErrorPresent: false,
    relaySessionPresent: true,
    localNoteState: '',
    atHostedRoot: true,
    pairedFragmentPresent: false,
  };
  const pageAnswers = [
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'captured', requestAtMs: 0, responseAtMs: 4, completedAtMs: 5 },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'unavailable', requestAtMs: 1, responseAtMs: 6, completedAtMs: 7 },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: ['fixture/repository'], bodyCapture: 'captured', requestAtMs: 8, responseAtMs: 18, completedAtMs: 19 },
    { source: 'local', pathKind: '/api/v1/boards', status: 200, boardNames: ['local-machine-b'], bodyCapture: 'captured', requestAtMs: 2, responseAtMs: 7, completedAtMs: 8 },
    { source: 'linked', pathKind: '/api/v1/boards/opaque-id/events?query=query-sentinel#fragment-sentinel', status: 200, boardNames: ['fixture/repository'], bodyCapture: null, requestAtMs: 3, responseAtMs: 21, completedAtMs: null, streamOpen: true,
      headers: { authorization: 'header-sentinel' }, body: 'body-sentinel' },
  ];
  const observed = await observeJourneyRows(
    () => waitFor(() => journeySidebarReady(['fixture/repository']), 'Browser condition did not arrive', 25),
    async () => JSON.stringify(seen),
    async () => pageAnswers,
  );
  assert.equal(observed.ready, false);
  assert.equal(observed.error.message, 'Browser condition did not arrive', 'diagnostics retain the original bounded row-wait failure');
  assert.equal(observed.report.pageCaptureAvailable, true);
  assert.equal(observed.report.apiCaptureAvailable, true);
  assert.ok(observed.report, 'a failed row wait reports its visible rows and page-used API answers');
  assert.deepEqual(observed.report.rows.slice(0, 4), [
    'repo: fixture/repository · linked · 1 item open',
    'repo-error: [redacted]: Sign in again to show local boards [redacted]',
    'empty: None yet.',
    'group: [redacted] · 2 repos',
  ], 'fixture, safe sign-in, and empty-state row text is preserved while unknown prose is redacted');
  assert.equal(observed.report.rows[4], 'repo: [redacted] · this computer · 1 item open',
    'an unexpected row remains visible with its label redacted and structured sidebar detail preserved');
  assert.equal(observed.report.rowsOmitted, 2, 'bounded row output reports its omitted count');
  assert.equal(observed.report.unknownRowsPresent, true);
  assert.deepEqual(observed.report.apiAnswers.map(({ source, pathKind, status, boardNames, bodyCapture, responseAtMs, streamOpen }) => ({ source, pathKind, status, boardNames, bodyCapture, responseAtMs, streamOpen })), [
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'captured', responseAtMs: 4, streamOpen: false },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: [], bodyCapture: 'unavailable', responseAtMs: 6, streamOpen: false },
    { source: 'linked', pathKind: '/api/v1/boards', status: 200, boardNames: ['fixture/repository'], bodyCapture: 'captured', responseAtMs: 18, streamOpen: false },
    { source: 'local', pathKind: '/api/v1/boards', status: 200, boardNames: ['local-machine-b'], bodyCapture: 'captured', responseAtMs: 7, streamOpen: false },
    { source: 'linked', pathKind: '/api/v1/boards/:id/events', status: 200, boardNames: ['fixture/repository'], bodyCapture: null, responseAtMs: 21, streamOpen: true },
  ]);
  assert.equal(journeyExpectedListAnswer(observed.report.apiAnswers, 'linked', 'fixture/repository')?.responseAtMs, 18,
    'a captured populated answer is selected after earlier empty and unavailable answers');
  assert.equal(journeyExpectedListAnswer(observed.report.apiAnswers.slice(0, 2), 'linked', 'fixture/repository'), null,
    'captured empty and unavailable answers never masquerade as the expected fixture response');
  assert.doesNotMatch(JSON.stringify(observed.report), /unlisted-board-sentinel|unknown-\d+|secret-token|private-key|person-987|\b987\b|private\/project|private\.example|query-sentinel|fragment-sentinel|header-sentinel|body-sentinel/u,
    'diagnostics never expose arbitrary row names, credentials, person identifiers, paths, URLs, API parts, headers or bodies');

  let pageRead = false;
  let answersRead = false;
  const passing = await observeJourneyRows(
    async () => true,
    async () => { pageRead = true; return ''; },
    async () => { answersRead = true; return []; },
  );
  assert.equal(passing.ready, true);
  assert.equal(pageRead || answersRead, false, 'a passing journey emits no additional diagnostic reads');

  const originalError = new Error('original row wait failure');
  const unavailable = await observeJourneyRows(
    async () => { throw originalError; },
    async () => { throw new Error('page capture unavailable'); },
    async () => { throw new Error('API trace unavailable'); },
  );
  assert.equal(unavailable.error, originalError, 'capture failure never replaces the original row wait error');
  assert.equal(unavailable.report.pageCaptureAvailable, false);
  assert.equal(unavailable.report.apiCaptureAvailable, false);
  assert.equal(unavailable.report.unknownRowsPresent, null, 'unavailable page facts are not presented as observed false values');
  assert.equal(unavailable.report.rowsOmitted, null, 'unavailable row capture is not reported as zero omitted rows');
  assert.equal(unavailable.report.apiAnswers, null, 'unavailable trace data is not presented as an empty observed trace');
});
