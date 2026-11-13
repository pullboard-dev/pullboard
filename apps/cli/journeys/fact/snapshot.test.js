// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit snapshot export checks, using the shared real-board fixtures [N26]. */
import { events as readStatsEvents } from '../../../../packages/store/index.js';
import { counterProofStats as readStatsCounter } from '../../../../packages/verify/index.js';
import assert from 'node:assert/strict';
import { closeBoard } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { openBoardForRead } from '../../../../packages/store/index.js';
import { proofStats } from '../../../../packages/stats/index.js';
import { compareFlowWindows } from '../../../../packages/stats/index.js';
import { portableSnapshot } from '../../../view/index.js';
import { viewProofSummary } from '../../../view/index.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  request,
} from 'node:http';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  sendBack,
  startView,
  boardId,
  boardOf,
  chromeExecutable,
  browserPause,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

const statsReadPorts = { events: readStatsEvents, counterProofStats: readStatsCounter };



/** Compare every projection field, evaluating running statistics at each real observation clock. */
function assertSnapshotObservation(expected, actual, board, root, message) {
  /** Apply the public view's compact projection at its recorded observation time. */
  const statisticsAt = (observation) => {
    const now = Date.parse(observation.proofStats.flow.asOf);
    assert.ok(Number.isFinite(now), 'the projection records a valid observation clock');
    assert.equal(observation.observedAt, new Date(now).toISOString(), 'the root read stamp matches its statistics observation clock');
    return portableSnapshot(JSON.parse(JSON.stringify(viewProofSummary(proofStats(board, { now }, statsReadPorts)))), root);
  };
  /** Drop the newest-event stamps: the live read ran before the oracle's snapshot, so a later wake may sit past it and only its stamp moves [N26]. */
  const withoutNewest = (value) => JSON.parse(JSON.stringify(value, (key, field) => (key === 'lastEventAt' ? undefined : field)));
  assert.deepEqual(withoutNewest(expected.proofStats), withoutNewest(statisticsAt(expected)), 'the live projection matches the public statistics reader at its clock');
  const actualStatistics = statisticsAt(actual);
  assert.deepEqual(actual.proofStats, actualStatistics, 'the export projection matches the public statistics reader at its clock');
  /** Check the complete comparison window against the same locked event prefix at each read clock. */
  const comparisonAt = observation => portableSnapshot(JSON.parse(JSON.stringify(compareFlowWindows(readStatsEvents(board), {
    now: Date.parse(observation.observedAt), windowMinutes: 120, complete: true,
  }))), root);
  assert.deepEqual(expected.statsComparison, comparisonAt(expected), 'the live comparison matches its public reader at its observation clock');
  const actualComparison = comparisonAt(actual);
  assert.deepEqual(actual.statsComparison, actualComparison, 'the export comparison matches its public reader at its observation clock');
  /** The Dashboard hero's four-hour window ends at its own read clock, so it moves with each observation; its counts must not [N26]. */
  const recentWindow = (observation, name) => {
    assert.ok(observation.dashboardRecent.until <= Date.parse(observation.observedAt), `${name} four-hour window ends at or before its read stamp`);
    assert.equal(observation.dashboardRecent.until - observation.dashboardRecent.since, 4 * 3_600_000, `${name} window spans four hours`);
  };
  recentWindow(expected, 'the live projection');
  recentWindow(actual, 'the export projection');
  const wanted = {
    ...expected,
    observedAt: actual.observedAt,
    proofStats: actualStatistics,
    statsComparison: actualComparison,
    dashboardRecent: actual.dashboardRecent,
    // The export is a served summary, which counts its finished items; the live read lists them whole, so the counts follow its items [#6588].
    ...(actual.finished ? { finished: { verified: expected.items.filter(item => item.status === 'verified').length, withdrawn: expected.items.filter(item => item.status === 'withdrawn').length } } : {}),
  };
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(wanted).sort(), `${message}: the same projection fields`);
  // Compare field by field so a red names the one field that moved between the two reads.
  /** An item with no claim carries claimHealth null live and omits it in the served summary; neither says anything different [#6588]. */
  const unclaimed = (value) => JSON.parse(JSON.stringify(value, (key, field) => (key === 'claimHealth' && field === null ? undefined : field)));
  for (const field of Object.keys(wanted)) assert.deepEqual(unclaimed(actual[field]), unclaimed(wanted[field]), `${message}: field ${field}`);
  assert.deepEqual(unclaimed(actual), unclaimed(wanted), message);
  const { since, until, ...liveCounts } = expected.dashboardRecent;
  const { since: exportSince, until: exportUntil, ...exportCounts } = actual.dashboardRecent;
  assert.deepEqual(exportCounts, liveCounts, 'the hero counts match across the two reads');
}

test('static export stays in its prefix and replays read-only in Chrome [A10,A3]', { timeout: 240_000 }, async (t) => { // budget: hang-only ceiling for fixture setup plus four real 1x/4x/16x replays on a loaded runner; no speed claim.
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the static replay proof.');

  const box = machine();
  const alpha = project(box, 'snapshot replay');
  box.run(alpha.repo, 'add', 'web', 'Replay greeting', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'greeting.html');
  sendBack(box, alpha, 1, 'the first greeting needs a correction');
  build(box, alpha, 1, 'greeting-fix.html');
  // Accept the submitted commit from a throwaway coordinator checkout, then always restore main.
  box.git(alpha.repo, 'switch', '-q', '--detach', alpha.branch);
  try { box.run(alpha.repo, 'verify', '1', 'accept', '--note', 'the corrected greeting renders', '--as', 'coordinator'); }
  finally { box.git(alpha.repo, 'switch', '-q', 'main'); }
  // Exercise the person's decision button so snapshot mode must hide this real mutation control.
  box.run(alpha.repo, 'shout', 'person', 'Should the replay stay read-only?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Snapshot stays read-only');
  const scriptShout = '<script>window.__snapshotShoutRan = true</script>';
  box.run(alpha.repo, 'shout', 'all', scriptShout);

  // Capture the live API state before export; the exported replay must finish at exactly this state.
  const live = await startView(box);
  let expected;
  try { expected = portableSnapshot(await boardOf(live, alpha.repo), alpha.repo); }
  finally { await live.stop(); }

  const observationBoard = openBoardForRead(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  assert.ok(observationBoard, 'the parity oracle reads the real native board');
  t.after(() => closeBoard(observationBoard));
  observationBoard.db.exec('BEGIN');
  const observationEvents = JSON.parse(JSON.stringify(events(observationBoard)));

  // The coordinator may write a landing wake after the observation: compare up to the observation cursor, never drop the equality.
  const upToCursor = (rows) => rows.slice(0, observationEvents.length);
  const snapshotOutput = box.exportSnapshot(alpha.repo, 'snapshot-export');
  const exportDir = snapshotOutput.root;
  assert.ok(existsSync(join(exportDir, 'index.html')));
  assert.ok(existsSync(join(exportDir, 'view.css')));
  const exportedBoards = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards.json'), 'utf8'));
  const boardId = exportedBoards.boards[0].id;
  const exportedEvents = upToCursor(JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards', boardId, 'events.json'), 'utf8')).events);
  const fullBoardLog = upToCursor(JSON.parse(box.run(alpha.repo, 'log', '--json')).events);
  assert.deepEqual(fullBoardLog, observationEvents, 'the live and exported projections share the same unchanged native history');
  assert.equal(exportedEvents.length, fullBoardLog.length, 'the snapshot exports every board event');
  assert.deepEqual(exportedEvents.map((event) => event.event_id), fullBoardLog.map((event) => event.event_id),
    'the snapshot event file contains the complete ordered board log');

  const prefix = '/demo/';
  const staticRequests = [];
  const outsideRequests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const entry = { method: request.method, path: url.pathname, headers: request.headers };
    staticRequests.push(entry);
    if (!url.pathname.startsWith(prefix)) {
      outsideRequests.push(entry);
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    let relativePath;
    try { relativePath = decodeURIComponent(url.pathname.slice(prefix.length)); }
    catch { response.writeHead(400).end(); return; }
    if (!relativePath) relativePath = 'index.html';
    const file = resolve(exportDir, relativePath);
    if (!file.startsWith(`${resolve(exportDir)}/`)) { response.writeHead(404).end(); return; }
    let body;
    try { body = snapshotOutput.readFile(file); }
    catch { response.writeHead(404).end(); return; }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.json') ? 'application/json; charset=utf-8'
      : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-snapshot-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${base}${prefix}`, profile);
    const evaluate = chrome.stable;
    await chrome.waitFor("document.body?.classList.contains('snapshot') && typeof snapshotReplay === 'object' && !!data?.project && snapshotReplay.events.length > 0 && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.waitFor("!!document.querySelector('#replay-play') && !!document.querySelector('#replay-pause') && !!document.querySelector('#replay-speed') && !!document.querySelector('#replay-progress')");

    const initial = JSON.parse(await evaluate(`JSON.stringify({ project: data.project, index: snapshotReplay.index, total: snapshotReplay.events.length, playing: snapshotReplay.playing, speedOptions: [...document.querySelector('#replay-speed').options].map((option) => option.value), bodyClass: document.body.classList.contains('snapshot') })`));
    assert.equal(initial.bodyClass, true);
    assert.equal(await evaluate('view.tab'), 'dashboard', 'a static export lands on Dashboard');
    assert.equal(await evaluate("Boolean(document.querySelector('[data-tab=home]'))"), false, 'a static export has no Home tab');
    assertSnapshotObservation(expected, initial.project, observationBoard, alpha.repo, 'the initial snapshot is the final live API state');
    assert.deepEqual(initial.speedOptions, ['1', '4', '16']);
    assert.ok(initial.total >= 6, 'the exported board contains the complete claim/submit/reject/claim/submit/accept history');
    assert.ok(initial.index >= initial.total - 1, 'the initial replay position is the exported final state');

    await chrome.send('Page.navigate', { url: `${base}${prefix}#home` });
    await chrome.waitFor("document.body.classList.contains('snapshot') && view.tab === 'dashboard' && snapshotReplay.index === snapshotReplay.events.length");
    assert.equal(await evaluate('location.hash'), '#dashboard', 'a saved or shared Home address normalizes to Dashboard');

    // Static export opens on Dashboard; materialize the lazy Shouts pane before reading its feed.
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && document.querySelector('#feed')?.textContent.includes(" + JSON.stringify(scriptShout) + ")");
    const shout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const feed = document.querySelector('#feed');
      return { text: feed.textContent, html: feed.innerHTML, scripts: feed.querySelectorAll('script').length };
    })())`));
    assert.ok(shout.text.includes(scriptShout), 'the shout is visible as literal text');
    assert.ok(shout.html.includes('&lt;script&gt;'), 'the snapshot escapes HTML in shout text');
    assert.equal(shout.scripts, 0, 'shout text never becomes an executable script element');

    // Replay assertions inspect item rows, so return from Shouts to the lazy Items pane first.
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden");
    await evaluate(`(() => {
      window.__snapshotRealAdvance = advanceReplay;
      window.__snapshotFirstPosition = null;
      window.advanceReplay = () => {
        window.__snapshotFirstPosition = { index: snapshotReplay.index, items: data.project.items.map((item) => item.id) };
        snapshotReplay.playing = false;
        replayControls();
      };
    })()`);
    await chrome.click("document.querySelector('#replay-play')");
    const firstPosition = JSON.parse(await evaluate('JSON.stringify(window.__snapshotFirstPosition)'));
    assert.deepEqual(firstPosition, { index: 0, items: [] }, 'play starts from an empty board before its first event');
    await evaluate('window.advanceReplay = window.__snapshotRealAdvance');

    const replayKinds = await evaluate(`JSON.stringify(snapshotReplay.events.map((event) => event.event_kind))`);
    const kinds = JSON.parse(replayKinds);
    const transitions = ['claim', 'submit', 'reject', 'claim', 'submit', 'accept'];
    let cursor = -1;
    for (const kind of transitions) {
      cursor = kinds.indexOf(kind, cursor + 1);
      assert.notEqual(cursor, -1, `replay includes ordered ${kind} event`);
    }

    const hiddenMutationControls = await evaluate(`JSON.stringify(['#new-item', '#add-form', '#shout-form', '#hold-form', '[data-release]', '[data-shout]', '[data-new]', '[data-go^="decide:"]'].filter((selector) => { const node = document.querySelector(selector); return node && !node.hidden && getComputedStyle(node).display !== 'none'; }))`);
    assert.deepEqual(JSON.parse(hiddenMutationControls), [], 'snapshot hides controls that could change the board');
    const writesBeforeAct = staticRequests.length;
    const directAction = await evaluate(`(async () => JSON.stringify({ result: await act('shout', { to: 'web', text: 'must remain local' }), message: document.body.innerText }))()`);
    assert.equal(JSON.parse(directAction).result, false, 'snapshot action refuses direct mutation calls');
    assert.match(JSON.parse(directAction).message, /snapshot/i, 'refusal explains that this is a snapshot');
    await browserPause(100);
    assert.equal(staticRequests.length, writesBeforeAct, 'a refused action makes no browser request');

    await evaluate(`(() => {
      window.__replayObserved = [];
      let previousIndex = null;
      const progress = document.querySelector('#replay-progress');
      new MutationObserver(() => {
        const index = snapshotReplay.index;
        if (index === previousIndex) return;
        previousIndex = index;
        const dot = document.querySelector('[data-item="1"] .dot');
        const status = dot && [...dot.classList].find((name) => ['open', 'building', 'verify', 'back', 'verified'].includes(name));
        if (status) window.__replayObserved.push({ index, status });
      }).observe(progress, { childList: true, characterData: true, subtree: true });
    })()`);
    await chrome.click("document.querySelector('#replay-play')");
    await chrome.waitFor('snapshotReplay.playing && snapshotReplay.index > 0 && snapshotReplay.index < snapshotReplay.events.length');
    // Record the event showing when the press reaches the page: a busy runner can take over a 1× interval between a
    // separate read and the press, so an index read beforehand races the replay rather than proving pause (#5738).
    await evaluate(`document.addEventListener('click', (event) => {
      if (event.target.closest?.('#replay-pause')) window.__replayIndexAtPause = snapshotReplay.index;
    }, { capture: true })`);
    await chrome.click("document.querySelector('#replay-pause')");
    const beforePause = await evaluate('window.__replayIndexAtPause');
    assert.ok(Number.isInteger(beforePause), 'the pause press reached the page');
    await chrome.waitFor('!snapshotReplay.playing');
    const pausedIndex = await evaluate('snapshotReplay.index');
    assert.equal(pausedIndex, beforePause, 'pause keeps the current replay event');
    await browserPause(180);
    assert.equal(await evaluate('snapshotReplay.index'), pausedIndex, 'a paused replay does not advance');

    await evaluate(`(() => {
      window.__replayScheduledDelays = [];
      const nativeSetTimeout = window.setTimeout.bind(window);
      /** Observe replay pacing while preserving each native browser timeout unchanged. */
      window.setTimeout = (callback, delay, ...args) => {
        if (callback === window.advanceReplay) window.__replayScheduledDelays.push(delay);
        return nativeSetTimeout(callback, delay, ...args);
      };
    })()`);
    /** Replay the complete exported history and compare scheduled timer values, not elapsed time. */
    const assertScheduledDelay = async (speed, delay) => {
      await evaluate(`(() => {
        window.__replayScheduledDelays.length = 0;
        replayPosition(snapshotReplay.events.length);
        const select = document.querySelector('#replay-speed');
        select.value = '${speed}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      assert.equal(await evaluate("document.querySelector('#replay-speed').value"), speed);
      await chrome.click("document.querySelector('#replay-play')");
      await chrome.waitFor('!snapshotReplay.playing', 30_000); // budget: hang-only ceiling for one complete replay.
      assert.equal(await evaluate('snapshotReplay.playing'), false, `${speed}× replay reaches its end`);
      assert.equal(await evaluate('snapshotReplay.index'), initial.total, `${speed}× replay renders the final exported event`);
      const scheduled = JSON.parse(await evaluate('JSON.stringify(window.__replayScheduledDelays)'));
      assert.equal(scheduled.length, initial.total - 1, `${speed}× schedules one timeout between each exported event`);
      assert.ok(scheduled.every((actual) => actual === delay), `${speed}× schedules ${delay} ms per step; got ${scheduled.join(', ')}`);
    };
    await assertScheduledDelay('1', 1000);
    await assertScheduledDelay('4', 250);
    await assertScheduledDelay('16', 62.5);
    assert.equal(await evaluate('snapshotReplay.playing'), false, 'each measured replay reaches its end');

    await evaluate(`(() => {
      window.__replayScheduledDelays.length = 0;
      replayPosition(snapshotReplay.events.length);
      const select = document.querySelector('#replay-speed');
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await press(chrome, "document.querySelector('#replay-play')");
    const atFour = JSON.parse(await evaluate('JSON.stringify({ playing: snapshotReplay.playing, delay: window.__replayScheduledDelays.at(-1) })'));
    const atSixteen = JSON.parse(await evaluate(`JSON.stringify((() => {
      const select = document.querySelector('#replay-speed');
      select.value = '16';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { playing: snapshotReplay.playing, delay: window.__replayScheduledDelays.at(-1) };
    })())`));
    await press(chrome, "document.querySelector('#replay-pause')");
    const changedSpeed = { wasPlaying: atFour.playing, atFour: atFour.delay, remainsPlaying: atSixteen.playing,
      atSixteen: atSixteen.delay, paused: !JSON.parse(await evaluate('JSON.stringify(snapshotReplay.playing)')) };
    assert.deepEqual(changedSpeed, { wasPlaying: true, atFour: 250, remainsPlaying: true, atSixteen: 62.5, paused: true },
      'changing speed while playing replaces the scheduled delay and leaves pause effective');
    await assertScheduledDelay('16', 62.5);
    const renderedStates = JSON.parse(await evaluate('JSON.stringify(window.__replayObserved.map((entry) => entry.status))'));
    const distinctStates = renderedStates.filter((state, index) => index === 0 || state !== renderedStates[index - 1]);
    const firstClaim = distinctStates.indexOf('building');
    assert.notEqual(firstClaim, -1, 'the rendered replay shows a claimed item');
    assert.deepEqual(distinctStates.slice(firstClaim, firstClaim + 6),
      ['building', 'verify', 'back', 'building', 'verify', 'verified'],
      'the actual item row renders claim, submit, reject, claim, submit, accept in order');
    const finalProject = await evaluate('JSON.stringify(data.project)');
    assertSnapshotObservation(expected, JSON.parse(finalProject), observationBoard, alpha.repo, 'replay ends at the same state served live before export');

    for (const [width, theme] of [[1280, 'light'], [375, 'dark']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'),
        'snapshot controls fit the viewport content area');
      if (process.env.PULLBOARD_SNAPSHOT_PROOF) {
        mkdirSync(process.env.PULLBOARD_SNAPSHOT_PROOF, { recursive: true });
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(process.env.PULLBOARD_SNAPSHOT_PROOF, `snapshot-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
    }

    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    const nonHttpRequests = chrome.requests.filter(({ url }) => !/^https?:/i.test(url));
    assert.ok(nonHttpRequests.every(({ url }) => url.startsWith('data:')), 'the only non-network browser URL may be a local data favicon');
    const browserRequests = chrome.requests.filter(({ url }) => /^https?:/i.test(url)).map(({ method, url, headers }) => ({
      method,
      origin: new URL(url).origin,
      path: new URL(url).pathname,
      hasBoardKey: Object.keys(headers).some((name) => name.toLowerCase() === 'x-pullboard-key'),
    }));
    assert.ok(browserRequests.length > 0);
    assert.ok(browserRequests.every((request) => request.origin === base), 'Chrome makes HTTP requests only to the static host');
    assert.deepEqual(browserRequests.filter((request) => !request.path.startsWith(prefix)), [], 'Chrome never requests outside /demo/');
    assert.ok(browserRequests.every((request) => request.method === 'GET' && !request.hasBoardKey), 'static assets and API JSON are GET-only and carry no board key');
    assert.deepEqual(outsideRequests, [], 'the static host receives no request outside /demo/');
    assert.ok(staticRequests.every((request) => request.method === 'GET' || request.method === 'HEAD'), 'the static host serves reads only');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
