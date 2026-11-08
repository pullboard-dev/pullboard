// pullboard: browser
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { createJourneyDeadline } from './journey-deadline.js';
import { relayClientFixture } from '../relay-client-fixture.js';
import { runFixtureChildAsync } from '../fixture-child.js';
import { findChromeExecutable, relayWorkBudgetMs } from '../relay-browser-fixture.js';
import { BIN, machine, project, fetchLive, startView, target, openSnapshotChrome, closeSnapshotChrome, pickProject } from './fixture.js';
import { JOURNEY_HOSTED, journeyRelaySite, interceptJourneyOrigins } from './relay-hosted-fixture.js';

test('the hosted page lists linked and local boards together [N26,H5]', {
  timeout: relayWorkBudgetMs() * 4 + 60_000,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async (t) => {
  const executable = findChromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the hosted mixed-board proof.');
  const journeyStartedAt = performance.now();
  let journeyPhase = 'setup-linked-relay-board';
  let journeyCleanupStage = 'test-body-cleanup-not-reached';
  let journeySucceeded = false;
  let journeyFailureDiagnosticEmitted = false;
  let journeyAbortDiagnosticEmitted = false;
  let journeyTrace = () => null;
  const journeyActionTrace = [];
  /** Emit one bounded event without exposing error messages, request URLs, or credentials. */
  const emitJourneyDiagnostic = (event, error = null, priorBodyError = null) => {
    let interception = null;
    try { interception = journeyTrace(); } catch { interception = { unavailable: true }; }
    /** Keep only bounded error identifiers; messages may contain fixture secrets. */
    const safeError = (value) => {
      if (!value) return null;
      const name = /^[A-Za-z][A-Za-z0-9_$.-]{0,79}$/u.test(String(value.name ?? '')) ? String(value.name) : null;
      const code = /^[A-Z0-9_]{1,64}$/u.test(String(value.code ?? '')) ? String(value.code) : null;
      return { name, code };
    };
    const record = { kind: 'hosted-local-journey-diagnostic', event, phase: journeyPhase,
      elapsedMs: Math.round(performance.now() - journeyStartedAt), cleanupStage: journeyCleanupStage,
      error: safeError(error), priorBodyError: safeError(priorBodyError), actionTrace: journeyActionTrace, interception };
    try { process.stderr.write('[hosted-local-journey] ' + JSON.stringify(record) + '\n'); } catch { /* Diagnostics must not replace the test failure. */ }
  };
  /** Report abort independently so a prior body-failure event cannot hide the cleanup stage. */
  const onJourneyAbort = () => {
    if (journeyAbortDiagnosticEmitted) return;
    journeyAbortDiagnosticEmitted = true;
    emitJourneyDiagnostic('test-signal-aborted', t.signal.reason, journeyBodyError ?? null);
    void cancelJourneyOwned(t.signal.reason);
  };
  let journeyBodyError;
  const journeyAbortController = new AbortController();
  const ownedStartupStops = new Set();
  /** Register a closer before resource startup yields; late startup cannot escape ownership. */
  const registerOwnedStartup = (stop) => { ownedStartupStops.add(stop); };
  let cancelJourneyOwned = (reason) => journeyAbortController.abort(reason);
  const journeyDeadline = createJourneyDeadline({ timeoutMs: relayWorkBudgetMs() * 4, onTimeout: (error) => {
    emitJourneyDiagnostic('own-deadline', error);
    return cancelJourneyOwned(error);
  } });
  let activeJourneyDeadline = journeyDeadline;
  journeyDeadline.setPhase(journeyPhase);
  t.signal.addEventListener('abort', onJourneyAbort, { once: true });
  t.after(() => {
    t.signal.removeEventListener('abort', onJourneyAbort);
    journeyDeadline.dispose();
    activeJourneyDeadline.dispose();
    if ((!journeySucceeded || journeyCleanupStage !== 'cleanup-complete') && !journeyFailureDiagnosticEmitted) {
      journeyFailureDiagnosticEmitted = true;
      emitJourneyDiagnostic('test-ended-before-success', journeyBodyError ?? null);
    }
  });
  const linked = await journeyDeadline.wait('set up linked board', () => relayClientFixture(t));
  const linkedId = linked.before.tables.board_meta.find((row) => row.meta_key === 'board_id').meta_value;
  const remoteTitle = 'linked machine A keeps its relay board';
  assert.equal((await journeyDeadline.wait('create linked item', () => linked.cli('add', linked.lane, remoteTitle))).code, 0, 'machine A creates a real relay fixture item');
  await journeyDeadline.wait('link first board', () => linked.link());
  const linkedKey = readFileSync(linked.keyFile, 'utf8').trim();

  journeyPhase = 'setup-local-project-fixtures';
  journeyDeadline.setPhase(journeyPhase);
  const local = machine();
  const localProject = project(local, 'local-machine-b');
  const localTitle = 'local machine B keeps its own view board';
  local.run(localProject.repo, 'add', 'web', localTitle);
  const duplicateProject = project(local, 'local-machine-c');
  const duplicateTitle = 'local machine C keeps its own view board';
  local.git(duplicateProject.repo, 'remote', 'add', 'origin', 'git@github.com:fixture/repository-2.git'); // one team board per repository [E12]
  local.run(duplicateProject.repo, 'add', 'web', duplicateTitle);
  journeyPhase = 'setup-local-relay-board';
  journeyDeadline.setPhase(journeyPhase);
  const localRelayEnv = {
    ...linked.env,
    HOME: local.dir,
    PULLBOARD_HOME: local.env.PULLBOARD_HOME,
    PULLBOARD_MACHINE_HOME: local.env.PULLBOARD_MACHINE_HOME,
    PATH: local.env.PATH,
  };
  const localRelayResult = await journeyDeadline.wait('link duplicate board', () => runFixtureChildAsync(process.execPath,
    [BIN, 'relay', 'on', '--url', linked.origin, '--json'],
    { cwd: duplicateProject.repo, env: localRelayEnv, timeout: relayWorkBudgetMs(), signal: journeyAbortController.signal }));
  assert.equal(localRelayResult.status, 0,
    'C links its actual local board to the relay as a second source for the same board identity');
  const localRelay = JSON.parse(readFileSync(join(duplicateProject.repo, '.git', 'pullboard', 'relay.json'), 'utf8'));
  const localRelayKey = readFileSync(join(local.env.PULLBOARD_HOME, 'relay-keys', localRelay.board + '.key'), 'utf8').trim();
  assert.notEqual(localRelay.board, linkedId, 'the linked C board is distinct from A');
  journeyPhase = 'start-view-browser-and-interception';
  journeyDeadline.setPhase(journeyPhase);
  const profile = join(linked.root, 'mixed-board-chrome');
  let localView;
  let site;
  let chrome;
  let ownedChrome;
  let closingChrome;
  let stopOrigins;
  const heldMoves = [];
  // The move's own reply is the act's outcome (#748): every relay read the following refresh makes waits here, so an
  // act that still waited on that whole-page refresh would never complete while they are held.
  const holdRelayReads = "(() => { const read = transport.request; window.__relayReadsHeld = []; window.__releaseRelayReads = () => { transport.request = read; for (const go of window.__relayReadsHeld.splice(0)) go(); }; transport.request = (path, body) => new Promise((resolve, reject) => window.__relayReadsHeld.push(() => read.call(transport, path, body).then(resolve, reject))); return true; })()";
  const releaseRelayReads = '(() => { window.__releaseRelayReads(); return true; })()';
  /** Read only the fixture's existing bounded, redacted interception trace. */
  journeyTrace = () => stopOrigins?.trace?.() ?? null;
  /** Close only this fixture's browser and reads; racing a promise never claims cancellation. */
  cancelJourneyOwned = (reason) => {
    journeyAbortController.abort(reason);
    const settling = [...ownedStartupStops].map((stop) => Promise.resolve().then(stop));
    if (stopOrigins) settling.push(stopOrigins.cancelOwned(reason));
    if (ownedChrome) {
      closingChrome ??= closeSnapshotChrome(ownedChrome);
      settling.push(closingChrome);
    }
    return Promise.allSettled(settling);
  };
  const safeJourneyError = (error) => {
    const message = String(error?.message ?? error ?? 'unknown error');
    return /^[A-Za-z0-9 _.:/-]{1,180}$/u.test(message) ? message : '<redacted error>';
  };
  try {
    localView = await journeyDeadline.wait('start local view', () => startView(local, { signal: journeyAbortController.signal, onOwned: registerOwnedStartup }));
    site = await journeyDeadline.wait('start hosted fixture', async () => {
      const started = await journeyRelaySite(linked, localView.base);
      // Listening is asynchronous too: dispose a late handoff if the caller already timed out.
      if (journeyAbortController.signal.aborted) {
        started.server.closeAllConnections();
        await new Promise((done) => started.server.close(done));
        throw journeyAbortController.signal.reason;
      }
      return started;
    });
    ownedChrome = await journeyDeadline.wait('start owned browser', () => openSnapshotChrome(executable, 'about:blank', profile, { signal: journeyAbortController.signal, onOwned: registerOwnedStartup }));
    chrome = new Proxy(ownedChrome, {
      /** Bound each browser call while keeping its real implementation and arguments unchanged. */
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args) => activeJourneyDeadline.wait(`browser ${String(key)}`, () => value.apply(target, args));
      },
    });
    stopOrigins = await interceptJourneyOrigins(chrome, site, localView, { deadline: () => activeJourneyDeadline, liveStreams: true });
    // Observe only fixed action-stage labels; no page values, request bodies or credentials enter diagnostics.
    const actionStages = new Set(['api-started', 'api-parsed', 'api-rejected', 'act-started', 'act-completed', 'act-rejected']);
    const actionListener = ({ data }) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.method !== 'Runtime.consoleAPICalled') return;
      const value = message.params?.args?.[0]?.value;
      if (typeof value !== 'string' || !value.startsWith('[held-local-action] ')) return;
      const stage = value.slice('[held-local-action] '.length);
      if (!actionStages.has(stage)) return;
      journeyActionTrace.push({ stage, phase: journeyPhase });
      if (journeyActionTrace.length > 16) journeyActionTrace.shift();
    };
    chrome.socket.addEventListener('message', actionListener);
    t.after(() => chrome.socket.removeEventListener('message', actionListener));
    const session = await journeyDeadline.wait('authenticate private browser', () => linked.phoneSession());
    assert.equal((await chrome.send('Network.setCookie', {
      name: 'pb_session', value: session.token, url: JOURNEY_HOSTED, httpOnly: true, sameSite: 'Lax',
    })).success, true, 'the fixture person session is installed only in this private browser');
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: JOURNEY_HOSTED, permissions }); break; } catch { /* Chrome versions expose different local-network permission names. */ }
    }

    journeyPhase = 'pair-linked-board-and-consume-key';
    journeyDeadline.setPhase(journeyPhase);
    // Pair the real board key in the fragment; the relay client consumes it into device storage before local discovery.
    await chrome.send('Page.navigate', { url: JOURNEY_HOSTED + '/#board=' + linkedId + '&key=' + encodeURIComponent(linkedKey) });
    await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(remoteTitle) + ')', 30_000); // budget: 30s hang ceiling for the real linked-board read under load.
    await chrome.waitFor('location.hash === ""', 10_000); // budget: 10s hang ceiling for relay-fragment consumption after the board renders.

    journeyPhase = 'pair-duplicate-board';
    journeyDeadline.setPhase(journeyPhase);
    // C's real local board is also paired on the relay so this catches duplicate-ID source preference.
    // Start a fresh hosted document before pairing C, then wait for transport work rather than assuming C is selected.
    await stopOrigins.leavePage();
    await chrome.send('Page.navigate', { url: JOURNEY_HOSTED + '/#board=' + localRelay.board + '&key=' + encodeURIComponent(localRelayKey) });
    await chrome.waitFor('location.hash === "" && !!JSON.parse(localStorage.getItem("pullboard.relay.keys.v1") || "{}")[' + JSON.stringify(localRelay.board) + ']', 30_000); // budget: 30s hang ceiling for paired-key storage to settle.
    assert.ok(linked.calls.some(call => call.method === 'GET'
      && call.path === '/api/v1/boards/' + localRelay.board + '/state' && call.browser),
    'C’s private pairing key was consumed and its real snapshot was read by the authenticated browser');

    journeyPhase = 'discover-combined-board-list';
    journeyDeadline.setPhase(journeyPhase);
    // The hosted page's real local-view handoff discovers B without a pasted key, URL or port.
    await stopOrigins.leavePage();
    await chrome.send('Page.navigate', { url: JOURNEY_HOSTED + '/' });
    await chrome.waitFor("[...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('fixture/repository')) && [...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('local-machine-b')) && [...document.querySelectorAll('#proj-list .proj.repo')].some(row => row.textContent.includes('local-machine-c'))");
    const localList = await (await fetchLive(localView.base + '/api/v1/boards', { headers: { 'x-pullboard-key': localView.key } })).json();
    const localId = localList.boards.find((board) => board.name === 'local-machine-b').id;
    const duplicateId = localList.boards.find((board) => board.name === 'local-machine-c').id;
    assert.equal(duplicateId, localRelay.board, 'C has one real board identity at both sources');
    const localOrigin = await chrome.stable('localSession?.origin || null');
    assert.equal(localOrigin, localView.base, 'the page keeps the ephemeral local origin from its real handoff');
    const rows = JSON.parse(await chrome.stable('JSON.stringify({ projects: data.projects.map(({id,name,root,source}) => ({id,name,root: source === \"relay\" ? \"relay\" : \"local\",source})), labels: [...document.querySelectorAll(\"#proj-list .proj.repo .pname\")].map(node => node.textContent), secretInAddress: /key=|pullboard-local=/.test(location.href) })'));
    assert.deepEqual(rows.labels.sort(), ['fixture/repository', 'local-machine-b', 'local-machine-c'], 'the page shows unlinked B and linked C locally beside A from the relay');
    assert.deepEqual(rows.projects.map((row) => row.id).sort(), [linkedId, localId, duplicateId].sort(), 'the hosted view keeps A, B and C identities');
    assert.equal(rows.projects.find((row) => row.id === linkedId).root, 'relay', 'a remote board uses an opaque root, not A’s filesystem path');
    assert.equal(rows.projects.find((row) => row.id === localId).source, 'local', 'unlinked B remains a local board');
    assert.equal(rows.projects.find((row) => row.id === duplicateId).source, 'local', 'C wins when its actual identity is present through both sources');
    assert.equal(rows.secretInAddress, false, 'the hosted page removes pairing and local-session fragments');
    assert.equal(rows.projects.filter((row) => row.id === duplicateId).length, 1, 'the duplicate local/relay identity appears once in the composed list');

    journeyPhase = 'exercise-local-and-relay-reads';
    journeyDeadline.setPhase(journeyPhase);
    const localRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('local-machine-b'))";
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(localTitle) + ") && !readOnly && !requests");
    const abortedPath = '/api/v1/boards/' + localId + '/state';
    const heldAbort = stopOrigins.holdNextResponse(({ method, path, search }) =>
      method === 'GET' && path === abortedPath && search === '?fixture_cancel=1');
    assert.equal(await chrome.stable(`(async () => {
      window.__journeyAbortController = new AbortController();
      window.__journeyAbortResult = null;
      window.__journeyAbortPromise = fetch(localReadBase + ${JSON.stringify(abortedPath + '?fixture_cancel=1')}, {
        headers: localReadHeaders, cache: 'no-store', signal: window.__journeyAbortController.signal,
      }).then(response => { window.__journeyAbortResult = { status: response.status }; return response.status; })
        .catch(error => { window.__journeyAbortResult = { name: error.name }; return error.name; });
      return 'started';
    })()`), 'started');
    const heldAbortResponse = await heldAbort;
    assert.equal(heldAbortResponse.status, 200, 'the real local API completed before its browser response was held');
    assert.deepEqual(await chrome.stable(`(async () => {
      window.__journeyAbortController.abort();
      await window.__journeyAbortPromise;
      return window.__journeyAbortResult;
    })()`), { name: 'AbortError' }, 'the page reports the actual browser fetch abort');
    const canceledInterception = await stopOrigins.waitForNetworkFailure((record) =>
      record.method === 'GET' && record.address.fixtureCancelProbe && record.networkFailure?.canceled === true);
    assert.equal(canceledInterception.networkFailure.canceled, true,
      'browser cancellation is correlated to this exact paused local-state request');
    heldAbortResponse.release();
    const duplicateRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('local-machine-c'))";
    await pickProject(chrome, duplicateRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(duplicateId) + ").root && document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(duplicateTitle) + ") && !readOnly && !requests");
    const remoteRow = "Array.from(document.querySelectorAll('#proj-list .proj.repo')).find(row => row.textContent.includes('fixture/repository'))";
    // Queue the call while a writable local board is selected, then release it only after the real
    // relay mapping and selected board settle. The late call must take the relay-board refusal.
    const lateMovePath = '/api/v1/boards/' + linkedId + '/moves';
    const lateMoveBody = { verb: 'shout', args: { to: 'coordinator', text: 'late relay writes stay refused' } };
    assert.equal(await chrome.stable(`(() => { window.__lateRelayMove = () => api(${JSON.stringify(lateMovePath)}, ${JSON.stringify(lateMoveBody)}); return !readOnly && !requests; })()`), true,
      'the late relay call is queued while the local board is writable');
    await pickProject(chrome, remoteRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(linkedId) + ").root && readOnly && requests");
    assert.equal(await chrome.stable(`boardSources.get(${JSON.stringify(linkedId)})?.kind`), 'relay',
      'the delayed call resolves to the actual linked relay board, without replacing its source');
    const relayWritesBefore = linked.calls.filter(call => call.method === 'POST' && call.path === lateMovePath).length;
    const lateRefusal = await chrome.stable(`(async () => { const release = window.__lateRelayMove; delete window.__lateRelayMove; try { await release(); return 'unexpected success'; } catch (error) { return error.message; } })()`);
    assert.match(lateRefusal, /read-only view/i, 'the late relay-board branch keeps the established read-only refusal');
    assert.equal(linked.calls.filter(call => call.method === 'POST' && call.path === lateMovePath).length, relayWritesBefore,
      'the late refused write never reaches the actual relay server');

    assert.ok(linked.calls.some((call) => call.method === 'GET' && call.path === '/api/v1/boards/' + linkedId + '/state'),
      'the relay board state is read through its relay transport');
    assert.ok(linked.calls.some((call) => call.method === 'GET' && call.path.startsWith('/api/v1/boards/' + linkedId + '/events')),
      'the relay board events use the relay client stream');
    const localReads = chrome.requests.filter((entry) => entry.url.startsWith(localOrigin + '/api/v1/boards/'));
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + localId + '/state'),
      'B board state is read through B’s local view');
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + localId + '/events'),
      'B board events use B’s local view stream');
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + duplicateId + '/state'),
      'C board state uses C’s local view despite its paired relay copy');
    assert.ok(localReads.some((entry) => new URL(entry.url).pathname === '/api/v1/boards/' + duplicateId + '/events'),
      'C board events use C’s local view despite its paired relay copy');
    assert.equal(localReads.some((entry) => new URL(entry.url).pathname.includes(linkedId)), false,
      'the local view never receives A’s relay board id');

    journeyPhase = 'hold-local-completion-across-board-switch';
    journeyDeadline.setPhase(journeyPhase);
    // Hold only delivery of a real local API response after the write has completed. Switching to a relay board
    // while it is in flight must not reinterpret the local response as a sealed request or clear that board's form.
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && !readOnly && !requests");
    await chrome.stable(`(() => {
      const stage = value => console.info('[held-local-action] ' + value);
      const priorApi = api;
      api = async (path, body) => {
        const tracked = body && path === ${JSON.stringify('/api/v1/boards/' + localId + '/moves')};
        if (tracked) stage('api-started');
        try {
          const result = await priorApi(path, body);
          if (tracked) stage('api-parsed');
          return result;
        } catch (error) {
          if (tracked) stage('api-rejected');
          throw error;
        }
      };
      window.__priorAct = act;
      window.__actOutcome = null;
      act = async (...args) => {
        stage('act-started');
        try {
          const result = await window.__priorAct(...args);
          window.__actOutcome = result;
          stage('act-completed');
          return result;
        } catch (error) { stage('act-rejected'); throw error; }
      };
      return true;
    })()`);
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'held local action'; true");
    const firstHeld = stopOrigins.holdNextResponse(({ method, path }) => method === 'POST' && path === '/api/v1/boards/' + localId + '/moves');
    await chrome.stable("document.querySelector('#add-title').value = 'held local action'; document.querySelector('#add-form').requestSubmit(); true");
    const firstResponse = await firstHeld;
    heldMoves.push(firstResponse.release);
    assert.ok(firstResponse.status >= 200 && firstResponse.status < 300, 'the local board accepted the real move before response delivery was held');
    await pickProject(chrome, remoteRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(linkedId) + ").root && readOnly && requests");
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'relay draft survives local completion'; true");
    assert.equal(await chrome.stable(holdRelayReads), true, 'relay reads wait for the fixture');
    firstResponse.release();
    await chrome.waitFor('window.__actOutcome !== null');
    assert.equal(await chrome.stable('window.__actOutcome'), true, 'a local write response is parsed using the mode it started with after switching to relay');
    assert.equal(await chrome.stable("document.querySelector('#add-title').value"), 'relay draft survives local completion', 'the older local completion does not clear the current relay draft');
    assert.equal(await chrome.stable(releaseRelayReads), true, 'the held relay reads go on');

    journeyPhase = 'hold-second-local-completion-across-reselection';
    journeyDeadline.setPhase(journeyPhase);
    // Switching away and back can leave the same root selected. A successful old submit must still preserve a new
    // draft entered in that board's form while the response was held.
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && !readOnly && !requests");
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'second held local action'; true");
    const secondHeld = stopOrigins.holdNextResponse(({ method, path }) => method === 'POST' && path === '/api/v1/boards/' + localId + '/moves');
    await chrome.stable('window.__actOutcome = null; true');
    await chrome.stable("document.querySelector('#add-form').requestSubmit(); true");
    const secondResponse = await secondHeld;
    heldMoves.push(secondResponse.release);
    assert.ok(secondResponse.status >= 200 && secondResponse.status < 300, 'the second real local write completes before delivery');
    await pickProject(chrome, remoteRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.id === " + JSON.stringify(linkedId) + ").root && readOnly && requests");
    await pickProject(chrome, localRow);
    await chrome.waitFor("view.root === data.projects.find(row => row.name === 'local-machine-b').root && !readOnly && !requests");
    await chrome.click("document.querySelector('#new-item')");
    await chrome.stable("document.querySelector('#add-title').value = 'replacement local draft'; true");
    assert.equal(await chrome.stable(holdRelayReads), true, 'relay reads wait for the fixture');
    secondResponse.release();
    await chrome.waitFor('window.__actOutcome !== null');
    assert.equal(await chrome.stable('window.__actOutcome'), true, 'the second local write completes on its own reply');
    assert.equal(await chrome.stable("document.querySelector('#add-title').value"), 'replacement local draft', 'a completion after switching away and back preserves the replacement draft');
    assert.equal(await chrome.stable(releaseRelayReads), true, 'the held relay reads go on');

    journeyPhase = 'assert-final-browser-state';
    journeyDeadline.setPhase(journeyPhase);
    assert.deepEqual(chrome.exceptions, [], 'the hosted mixed-board page reports no uncaught browser exceptions');
    journeySucceeded = true;
  } catch (error) {
    journeyBodyError = error;
    if (!journeyFailureDiagnosticEmitted) {
      journeyFailureDiagnosticEmitted = true;
      emitJourneyDiagnostic('ordinary-failure', error);
    }
    throw error;
  } finally {
    journeyDeadline.dispose();
    // Split the existing sixty-second outer reserve: half for explicit cleanup, half for registered after-hooks and scheduling.
    activeJourneyDeadline = createJourneyDeadline({ timeoutMs: 60_000 / 2, onTimeout: (error) => {
      emitJourneyDiagnostic('cleanup-deadline', error, journeyBodyError ?? null);
      return cancelJourneyOwned(error);
    } });
    activeJourneyDeadline.setPhase(journeyPhase);
    journeyCleanupStage = 'release-held-responses';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    for (const release of heldMoves) release();
    const journeyCleanupErrors = [];
    journeyCleanupStage = 'stop-interception';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { if (stopOrigins) await stopOrigins(); } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'close-browser';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { if (ownedChrome) await (closingChrome ??= closeSnapshotChrome(ownedChrome)); } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'stop-local-view';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { if (localView) await localView.stop(); } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'close-hosted-fixture-server';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try {
      if (site?.server) {
        site.server.closeAllConnections();
        if (site.server.listening) await new Promise((done, reject) => site.server.close((error) => error ? reject(error) : done()));
      }
    } catch (error) { journeyCleanupErrors.push(error); }
    journeyCleanupStage = 'remove-browser-profile';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { journeyCleanupErrors.push(error); }
    if (!journeyBodyError && !journeyCleanupErrors.length) {
      const trace = stopOrigins.trace();
      t.diagnostic(JSON.stringify({ kind: 'owned-browser-cancellation-proof', actionTrace: journeyActionTrace, requestCount: trace.requestCount, liveStreamCount: trace.liveStreamCount, failureCount: trace.failureCount,
        incompleteCount: trace.incompleteCount, confirmedBrowserCancellationCount: trace.confirmedBrowserCancellationCount,
        probe: trace.requests.find((record) => record.fixtureCancelProbe) }));
    }
    if (journeyCleanupErrors.length && !journeyFailureDiagnosticEmitted) {
      journeyCleanupStage = 'cleanup-failed';
    activeJourneyDeadline.setCleanupStage(journeyCleanupStage);
      journeyFailureDiagnosticEmitted = true;
      emitJourneyDiagnostic('cleanup-failure', journeyCleanupErrors[0]);
    }
    if (!journeyBodyError && !journeyCleanupErrors.length) journeyCleanupStage = 'cleanup-complete';
    if (journeyCleanupErrors.length) {
      t.diagnostic(JSON.stringify({
        testBodyCompletedSuccessfully: !journeyBodyError,
        testBodyFailure: journeyBodyError ? { name: journeyBodyError.name, code: journeyBodyError.code ?? null,
          stackFrames: String(journeyBodyError.stack ?? '').split('\n').filter((line) => /^\s+at\s/u.test(line)).slice(0, 6) } : null,
        cleanupFailureCount: journeyCleanupErrors.length,
        cleanupFailures: journeyCleanupErrors.slice(0, 8).map(safeJourneyError),
        interception: stopOrigins?.trace?.() ?? null,
      }));
      const failures = journeyBodyError ? [journeyBodyError, ...journeyCleanupErrors] : journeyCleanupErrors;
      throw new AggregateError(failures, 'hosted mixed-board test and/or cleanup failed: ' + failures.slice(0, 8).map(safeJourneyError).join(' | '));
    }
  }
});
