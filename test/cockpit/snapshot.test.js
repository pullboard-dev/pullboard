/** @pullboard-test-gui */
/** Cockpit snapshot checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fetchLocal } from '../../src/local-fetch.js';
import { closeBoard } from '../../src/board.js';
import { events } from '../../src/board.js';
import { openBoardForRead } from '../../src/board-read-open.js';
import { proofStats } from '../../src/stats.js';
import { exportView, portableSnapshot } from '../../src/serve.js';
import { machine, project, build, sendBack, fetchLive, startView, accept, boardId, boardOf, chromeExecutable, browserPause, openSnapshotChrome, closeSnapshotChrome, press, travel, settled, roadmapRow, showing, readRoadmap, openRoadmapParts, serveFolder, proofShot } from './fixture.js';


/** Compare every projection field, evaluating running statistics at each real observation clock. */
function assertSnapshotObservation(expected, actual, board, root, message) {
  /** Read the entire public statistics projection at its recorded observation time. */
  const statisticsAt = (observation) => {
    const now = Date.parse(observation.proofStats.flow.asOf);
    assert.ok(Number.isFinite(now), 'the projection records a valid observation clock');
    assert.equal(observation.observedAt, new Date(now).toISOString(), 'the root read stamp matches its statistics observation clock');
    return portableSnapshot(JSON.parse(JSON.stringify(proofStats(board, { now }))), root);
  };
  assert.deepEqual(expected.proofStats, statisticsAt(expected), 'the live projection matches the public statistics reader at its clock');
  const actualStatistics = statisticsAt(actual);
  assert.deepEqual(actual.proofStats, actualStatistics, 'the export projection matches the public statistics reader at its clock');
  assert.deepEqual(actual, { ...expected, observedAt: actual.observedAt, proofStats: actualStatistics }, message);
}

test('static export stays in its prefix and replays read-only in Chrome [A10,A3]', { timeout: 90_000 }, async (t) => {
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

  const exportDir = join(box.dir, 'snapshot-export');
  box.run(alpha.repo, 'view', '--export', exportDir);
  assert.ok(existsSync(join(exportDir, 'index.html')));
  assert.ok(existsSync(join(exportDir, 'view.css')));
  const exportedBoards = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards.json'), 'utf8'));
  const boardId = exportedBoards.boards[0].id;
  const exportedEvents = JSON.parse(readFileSync(join(exportDir, 'api', 'v1', 'boards', boardId, 'events.json'), 'utf8')).events;
  const fullBoardLog = JSON.parse(box.run(alpha.repo, 'log', '--json')).events;
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
    try { body = readFileSync(file); }
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
    assertSnapshotObservation(expected, initial.project, observationBoard, alpha.repo, 'the initial snapshot is the final live API state');
    assert.deepEqual(initial.speedOptions, ['1', '4', '16']);
    assert.ok(initial.total >= 6, 'the exported board contains the complete claim/submit/reject/claim/submit/accept history');
    assert.ok(initial.index >= initial.total - 1, 'the initial replay position is the exported final state');

    const shout = JSON.parse(await evaluate(`JSON.stringify((() => {
      const feed = document.querySelector('#feed');
      return { text: feed.textContent, html: feed.innerHTML, scripts: feed.querySelectorAll('script').length };
    })())`));
    assert.ok(shout.text.includes(scriptShout), 'the shout is visible as literal text');
    assert.ok(shout.html.includes('&lt;script&gt;'), 'the snapshot escapes HTML in shout text');
    assert.equal(shout.scripts, 0, 'shout text never becomes an executable script element');

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
    const beforePause = await evaluate('snapshotReplay.index');
    await chrome.click("document.querySelector('#replay-pause')");
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

test("the static export's Pause keeps its box through a press [A10,N26,C7]", { timeout: 60_000 }, // budget: hang-only ceiling for two viewport press journeys in isolated Chrome.
  async () => {
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required for the static Pause press proof');
    const box = machine();
    const alpha = project(box, 'snapshot replay');
    box.run(alpha.repo, 'add', 'web', 'Replay greeting', '--specs', 'G1', '--criterion', 'renders');
    build(box, alpha, 1, 'greeting.html');
    sendBack(box, alpha, 1, 'the first greeting needs a correction');
    build(box, alpha, 1, 'greeting-fix.html');
    box.git(alpha.repo, 'switch', '-q', '--detach', alpha.branch);
    try { box.run(alpha.repo, 'verify', '1', 'accept', '--note', 'the corrected greeting renders', '--as', 'coordinator'); }
    finally { box.git(alpha.repo, 'switch', '-q', 'main'); }
    box.run(alpha.repo, 'shout', 'person', 'Should the replay stay read-only?', '--decision');
    box.run(alpha.repo, 'hold', 'web', '--reason', 'Snapshot stays read-only');
    box.run(alpha.repo, 'shout', 'all', '<script>window.__snapshotShoutRan = true</script>');
    const folder = join(box.dir, 'pause-export');
    box.run(alpha.repo, 'view', '--export', folder);
    const host = await serveFolder(folder, '/demo/');
    let chrome;
    try {
      chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, join(box.dir, 'pause-chrome'));
      await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
      for (const width of [null, 375]) {
        if (width !== null) await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.stable(`replayPosition(snapshotReplay.events.length)`);
        await press(chrome, "document.querySelector('#replay-play')");
        const before = await chrome.stable(`(() => {
          // Hold only the next callback until the real pointer move, then deliver real replay steps.
          clearTimeout(snapshotReplay.timer);
          const pause = document.querySelector('#replay-pause');
          window.__pauseEndWitness = { before: { index: snapshotReplay.index, playing: snapshotReplay.playing,
            disabled: pause.disabled, label: pause.textContent }, moves: 0 };
          /** Finish the actual replay between the original shared press's aim and assertion. */
          pause.addEventListener('mousemove', () => {
            window.__pauseEndWitness.moves++;
            while (snapshotReplay.playing) { clearTimeout(snapshotReplay.timer); advanceReplay(); }
            clearTimeout(snapshotReplay.timer);
            window.__pauseEndWitness.after = { index: snapshotReplay.index, playing: snapshotReplay.playing,
              disabled: pause.disabled, label: pause.textContent };
          }, { once: true });
          return window.__pauseEndWitness.before;
        })()`);
        assert.equal(before.playing, true, `${width}: Pause is aimed while replay is running`);
        assert.equal(before.disabled, false, `${width}: Pause starts enabled`);
        await press(chrome, "document.querySelector('#replay-pause')");
        const seen = await chrome.stable('({ witness: window.__pauseEndWitness, total: snapshotReplay.events.length })');
        assert.equal(seen.witness.moves, 1, `${width}: native pointer movement delivers the controlled interleaving`);
        assert.deepEqual(seen.witness.after, { index: seen.total, playing: false, disabled: true, label: 'Pause' },
          `${width}: actual replay end disables the same Pause label during the press`);
        console.log('PULLBOARD_499_END_PRESS ' + JSON.stringify({ width, ...seen }));
      }
      assert.deepEqual(chrome.exceptions, [], 'the end-during-press snapshot has no browser exceptions');
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await host.close();
    }
  });

test('replay speed is judged by its scheduled delay [A10,C7]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled replay timing proof');
  const box = machine();
  const alpha = project(box, 'throttled-snapshot');
  for (let id = 1; id <= 6; id++) {
    box.run(alpha.repo, 'add', 'web', `Throttled replay item ${id}`, '--specs', 'G1', '--criterion', 'replays');
  }
  const folder = join(box.dir, 'throttled-export');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = join(box.dir, 'throttled-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const total = await chrome.stable('snapshotReplay.events.length');
    assert.ok(total >= 6, 'the exported history contains at least six native item moves');
    await chrome.stable(`(() => {
      window.__replayScheduledDelays = [];
      const nativeSetTimeout = window.setTimeout.bind(window);
      /** Observe replay pacing while preserving each native browser timeout unchanged. */
      window.setTimeout = (callback, delay, ...args) => {
        if (callback === window.advanceReplay) window.__replayScheduledDelays.push(delay);
        return nativeSetTimeout(callback, delay, ...args);
      };
    })()`);
    /** Confirm the pacing value for every scheduled step in a complete CPU-throttled replay. */
    const assertThrottledDelay = async (speed, delay) => {
      await chrome.stable(`(() => {
        window.__replayScheduledDelays.length = 0;
        replayPosition(snapshotReplay.events.length);
        const select = document.querySelector('#replay-speed');
        select.value = '${speed}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await press(chrome, "document.querySelector('#replay-play')");
      await chrome.waitFor('!snapshotReplay.playing', 30_000); // budget: hang-only ceiling for one complete replay.
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${speed}× replay reaches its end`);
      assert.equal(await chrome.stable('snapshotReplay.index'), total, `${speed}× replay renders the final exported event`);
      const scheduled = await chrome.stable('window.__replayScheduledDelays');
      assert.equal(scheduled.length, total - 1, `${speed}× schedules one delay between every replay step`);
      assert.ok(scheduled.every((actual) => actual === delay), `${speed}× schedules ${delay} ms per step`);
    };
    await assertThrottledDelay('1', 1000);
    await assertThrottledDelay('4', 250);
    await assertThrottledDelay('16', 62.5);
    await chrome.stable(`(() => {
      window.__replayScheduledDelays.length = 0;
      replayPosition(snapshotReplay.events.length);
      const select = document.querySelector('#replay-speed');
      select.value = '4';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await press(chrome, "document.querySelector('#replay-play')");
    const atFour = await chrome.stable('({ playing: snapshotReplay.playing, delay: window.__replayScheduledDelays.at(-1) })');
    const atSixteen = await chrome.stable(`(() => {
      const select = document.querySelector('#replay-speed');
      select.value = '16';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { playing: snapshotReplay.playing, delay: window.__replayScheduledDelays.at(-1) };
    })()`);
    await press(chrome, "document.querySelector('#replay-pause')");
    const changedSpeed = { wasPlaying: atFour.playing, atFour: atFour.delay, remainsPlaying: atSixteen.playing,
      atSixteen: atSixteen.delay, paused: !(await chrome.stable('snapshotReplay.playing')) };
    assert.deepEqual(changedSpeed, { wasPlaying: true, atFour: 250, remainsPlaying: true, atSixteen: 62.5, paused: true },
      'changing speed while playing replaces the scheduled delay under CPU throttle');
    assert.deepEqual(chrome.exceptions, [], 'the throttled snapshot reports no uncaught browser errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
  }
});

/** Measure every interactive replay control through its real start, pause, and end states. */
const replayControlsStayPut = (wideFonts = false, classicScrollbar = false) => async function replayControlsStayPutCase(t) {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for replay control geometry coverage');
  const box = machine();
  const alpha = project(box, 'stable-replay-controls');
  for (let id = 1; id <= 6; id++) {
    box.run(alpha.repo, 'add', 'web', `Replay geometry item ${id}`, '--specs', 'G1', '--criterion', 'replay controls stay put');
  }
  const folder = join(box.dir, 'stable-replay-controls-export');
  box.run(alpha.repo, 'view', '--export', folder);
  if (classicScrollbar) {
    const stylesheet = join(folder, 'view.css');
    writeFileSync(stylesheet, readFileSync(stylesheet, 'utf8') + '\n::-webkit-scrollbar { width: 15px; }\n');
  }
  const host = await serveFolder(folder, '/demo/');
  const profile = join(box.dir, 'stable-replay-controls-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const total = await chrome.stable('snapshotReplay.events.length');
    assert.ok(total >= 6, 'the exported replay has enough events to exercise all control states');
    /** Sample original comparison boxes and runner layout evidence in the same browser evaluation. */
    const readControlBoxes = async (width, state) => {
      const capture = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const selectors = ['#replay-play', '#replay-pause', '#replay-speed'];
        const boxes = Object.fromEntries(selectors.map(selector => {
          const node = document.querySelector(selector);
          const rect = node.getBoundingClientRect();
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
        }));
        const controls = selectors.map(selector => {
          const node = document.querySelector(selector);
          const style = getComputedStyle(node);
          const parent = node.parentElement;
          const track = getComputedStyle(parent);
          return { id: node.id, box: boxes[selector], label: node.textContent,
            selectedLabel: node.selectedOptions?.[0]?.textContent ?? null,
            fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
            lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
            width: style.width, minWidth: style.minWidth, maxWidth: style.maxWidth,
            track: { parent: parent.id || parent.className, display: track.display,
              columns: track.gridTemplateColumns, rows: track.gridTemplateRows,
              flexDirection: track.flexDirection, flexWrap: track.flexWrap,
              gap: track.gap, parentWidth: track.width, flexBasis: style.flexBasis,
              flexGrow: style.flexGrow, flexShrink: style.flexShrink,
              columnStart: style.gridColumnStart, columnEnd: style.gridColumnEnd } };
        });
        const root = document.documentElement;
        const scroller = document.scrollingElement;
        const rootStyle = getComputedStyle(root);
        return { boxes, controls, observedAt: Date.now(),
          viewport: { innerWidth, innerHeight, clientWidth: root.clientWidth,
            bodyClientWidth: document.body.clientWidth, scrollWidth: scroller.scrollWidth,
            scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
            scrollbarWidth: innerWidth - root.clientWidth,
            scrollbarGutter: rootStyle.scrollbarGutter, overflowY: rootStyle.overflowY },
          browser: { userAgent: navigator.userAgent, platform: navigator.platform, devicePixelRatio },
          replay: { index: snapshotReplay.index, total: snapshotReplay.events.length,
            playing: snapshotReplay.playing } };
      })())`));
      t.diagnostic('replay control boxes ' + JSON.stringify({ width, state,
        runner: { node: process.version, platform: process.platform, arch: process.arch }, ...capture }));
      if (classicScrollbar && state === 'end') {
        assert.equal(capture.viewport.scrollbarWidth, 15, `${width}: the fixture uses the measured native 15px classic scrollbar`);
        if (width === 375) assert.ok(capture.viewport.scrollHeight > capture.viewport.clientHeight, `${width}: the final event list needs vertical scrolling`);
      }
      return capture.boxes;
    };
    /** Exercise real browser input and compare control geometry within one viewport. */
    const verifyWidth = async (width) => {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      if (wideFonts) {
        await chrome.stable(`(() => {
          const sheet = document.styleSheets[0];
          sheet.insertRule('.snapshot-controls, .snapshot-controls * { letter-spacing: .12em !important; }', sheet.cssRules.length);
        })()`);
        const spacing = JSON.parse(await chrome.stable(`JSON.stringify(
          ['#snapshot-controls > span', '#replay-play', '#replay-pause', '#replay-speed', '#replay-progress']
            .map(selector => getComputedStyle(document.querySelector(selector)).letterSpacing)
        )`));
        assert.ok(spacing.every(value => Number.parseFloat(value) > 0),
          `${width}: every replay control receives the wide-font fixture`);
      }
      await chrome.stable(`(() => {
        replayPosition(0);
        const speed = document.querySelector('#replay-speed');
        speed.value = '1';
        speed.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const atStart = await readControlBoxes(width, 'start');
      assert.equal(await chrome.stable("document.querySelector('#replay-play').textContent"), 'Play',
        `${width}: the start-state label is the short Play label`);
      await press(chrome, "document.querySelector('#replay-play')");
      assert.equal(await chrome.stable('snapshotReplay.playing'), true, `${width}: native Play starts replay`);
      const whilePlaying = await readControlBoxes(width, 'after Play');
      await press(chrome, "document.querySelector('#replay-pause')");
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${width}: native Pause pauses replay`);
      const whilePaused = await readControlBoxes(width, 'after Pause');
      await chrome.stable(`(() => {
        replayPosition(snapshotReplay.events.length - 1);
        document.querySelector('#replay-speed').value = '16';
        document.querySelector('#replay-speed').dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await press(chrome, "document.querySelector('#replay-play')");
      assert.equal(await chrome.stable('snapshotReplay.index'), total, `${width}: final Play renders the end state`);
      assert.equal(await chrome.stable('snapshotReplay.playing'), false, `${width}: replay stops at its final event`);
      const atEnd = await readControlBoxes(width, 'end');
      assert.equal(await chrome.stable("document.querySelector('#replay-play').textContent"), 'Play from first event',
        `${width}: the end-state label exercises the longer Play text`);
      for (const [state, boxes] of Object.entries({ whilePlaying, whilePaused, atEnd })) {
        assert.deepEqual(boxes, atStart, `${width}: every interactive replay control keeps its box unchanged ${state}`);
      }
    };
    for (const width of (wideFonts ? [375] : [375, 1280])) {
      await verifyWidth(width);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
};

test('the replay controls don\'t move when the replay starts [A10,C7]', { timeout: 60_000 }, // budget: hang-only ceiling for two viewport geometry passes.
  replayControlsStayPut());

test('the replay controls hold their place at 375 with wide fonts [A10,C7]', { timeout: 60_000 }, // budget: hang-only ceiling for one viewport geometry pass.
  replayControlsStayPut(true));

test('the replay controls hold their place with a classic scrollbar [A10,C7]', { timeout: 60_000 }, // budget: hang-only ceiling for two viewport geometry passes.
  replayControlsStayPut(false, true));

test('static export redacts structured checkout paths but preserves paths people wrote [A10]', async () => {
  const box = machine();
  const alpha = project(box, 'private-project');
  box.run(alpha.repo, 'add', 'web', 'Private checkout item', '--specs', 'G1', '--criterion', 'exports without checkout paths');
  const projectRoot = alpha.repo;
  const worktreeRoot = alpha.web;
  const commonGitDir = box.git(alpha.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const live = await startView(box);
  try {
    const listingResponse = await fetchLive(`${live.base}/api/v1/boards`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    const board = listing.boards.find((entry) => entry.root === projectRoot);
    assert.ok(board, 'the live listing keeps the absolute project root');
    assert.equal(board.root, projectRoot);
    const state = await boardOf(live, projectRoot);
    assert.equal(state.root, projectRoot, 'live state keeps the absolute root');
    const agent = state.agents.find((entry) => entry.agent_id === 'web-1');
    assert.ok(agent);
    assert.equal(agent.agent_path, worktreeRoot, 'live state keeps the agent worktree path');
    assert.equal(box.git(alpha.web, 'rev-parse', '--path-format=absolute', '--git-common-dir'), commonGitDir,
      'the linked worktree still shares the repository common Git directory');
    const boardEvents = await fetchLive(`${live.base}/api/v1/boards/${board.id}/events`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(boardEvents.status, 200);
    const events = await boardEvents.json();
    assert.ok(events.events.length > 0);

    /** Enumerate every exported file, including the API document subtree. */
    const filesBelow = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    });
    /** Read all bytes so an unexpected exported field cannot hide a private folder. */
    const exportedText = (directory) => filesBelow(directory).map((path) => readFileSync(path, 'utf8')).join('\n');
    const snapshot = join(box.dir, 'export-structured');
    box.run(alpha.repo, 'view', '--export', snapshot);
    const structuredFiles = exportedText(snapshot);
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!structuredFiles.includes(privatePath), `export does not include structured path ${privatePath}`);
    }

    // A second export deliberately includes paths in human-authored prose. Those exact values are
    // the only allowed occurrences; project.root, agent_path and common Git metadata stay redacted.
    const brief = `Keep this literal checkout reference: ${projectRoot}`;
    const shout = `Please inspect this literal agent folder: ${worktreeRoot}`;
    box.run(alpha.repo, 'add', 'web', 'Path in prose', '--specs', 'G1', '--criterion', 'keeps prose literal', '--brief', brief);
    box.run(alpha.web, 'shout', 'all', shout);
    const proseSnapshot = join(box.dir, 'export-prose');
    box.run(alpha.repo, 'view', '--export', proseSnapshot);
    const stateFile = JSON.parse(readFileSync(join(proseSnapshot, 'api', 'v1', 'boards', board.id, 'state.json'), 'utf8')).state;
    assert.notEqual(stateFile.root, projectRoot, 'export redacts structured project root');
    assert.notEqual(stateFile.agents.find((entry) => entry.agent_id === 'web-1').agent_path, worktreeRoot,
      'export redacts the structured agent worktree');
    assert.equal(stateFile.items.find((entry) => entry.title === 'Path in prose').brief, brief);
    assert.ok(stateFile.shouts.some((entry) => entry.shout_text === shout), 'the authored shout remains literal');
    const proseFiles = filesBelow(proseSnapshot).map((path) => readFileSync(path, 'utf8'));
    let scrubbedText = proseFiles.join('\n');
    for (const text of [brief, shout]) {
      scrubbedText = scrubbedText.replaceAll(JSON.stringify(text), '"<authored prose>"')
        .replaceAll(JSON.stringify(JSON.stringify(text)).slice(1, -1), '<authored event prose>');
    }
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!scrubbedText.includes(privatePath), `outside authored prose, export does not include ${privatePath}`);
    }
  } finally {
    await live.stop();
  }
});

test('an exported roadmap has its own address under a folder, and Back and Forward return to it [N38,A10]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for exported roadmap checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-snapshot');
  const beacon = project(box, 'beacon');
  box.run(alpha.repo, 'add', 'web', 'Verified page', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'web', 'Open page', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  box.run(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  box.run(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships with the snapshot.', '--items', '1,2,beacon#1');
  box.run(alpha.repo, 'milestone', 'add', 'Later');
  const folder = join(box.dir, 'roadmap-export');
  box.run(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-export-chrome-'));
  const ready = "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length";
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, `${ready} && ${showing('items', '/demo/')}`);
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', '/demo/#roadmap'));
    await openRoadmapParts(chrome);
    const seen = await readRoadmap(chrome);
    assert.deepEqual(seen.cards[0].rows.map(({ id, label, tone, button }) => ({ id, label, tone, button })), [
      { id: '#1', label: 'accepted', tone: 'ok', button: true },
      { id: '#2', label: 'unclaimed', tone: 'free', button: true },
      { id: 'beacon#1', label: 'unclaimed', tone: 'free', button: true },
    ], "the snapshot's rows expand in place; another repo's unavailable item has no Items link");
    assert.equal(seen.cards[0].rows.find((row) => row.id === 'beacon#1').tip, 'Billing webhook retries (not in this snapshot)', 'and says why');
    assert.deepEqual([seen.cards[1].name, seen.cards[1].empty], ['Later', 'No items yet.']);

    await press(chrome, roadmapRow('beacon#1'));
    await chrome.waitFor(roadmapRow('beacon#1') + ".getAttribute('aria-expanded') === 'true'");
    assert.equal(await chrome.stable('location.pathname + location.hash'), '/demo/#roadmap');
    assert.match(await chrome.stable(roadmapRow('beacon#1') + ".parentElement.querySelector('.milestone-why').textContent"), /not in this snapshot/u);
    assert.equal(await chrome.stable(roadmapRow('beacon#1') + ".parentElement.querySelectorAll('.milestone-why a[data-go]').length"), 0, 'unavailable items expand to why, without a false navigation target');
    await press(chrome, roadmapRow('beacon#1'));

    // The address survives a reload on a static host, and Back and Forward show the tab it names,
    // whether the browser keeps the page for an entry or loads it again.
    await chrome.send('Page.reload');
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')} && !!${roadmapRow('#1')}`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('items', '/demo/')}`);
    await travel(chrome, 1);
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')} && !!${roadmapRow('#2')}`);
    await press(chrome, roadmapRow('#2'));
    await chrome.waitFor(roadmapRow('#2') + ".getAttribute('aria-expanded') === 'true'");
    assert.equal(await chrome.stable('location.pathname + location.hash'), '/demo/#roadmap', 'a snapshot row click stays on Roadmap');
    await press(chrome, roadmapRow('#2') + ".parentElement.querySelector('.milestone-why a[data-go]')");
    await chrome.waitFor(`${showing('items', '/demo/#items/2')} && document.querySelector('#detail h2')?.innerText.includes('Open page')`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('roadmap', '/demo/#roadmap')}`);

    // Opened afresh, the folder shows the board's tab, and its #roadmap address the Roadmap.
    for (const [address, pane] of [['/demo/', 'items'], ['/demo/#roadmap', 'roadmap']]) {
      await chrome.send('Page.navigate', { url: 'about:blank' });
      await settled(chrome, "location.href === 'about:blank'");
      await chrome.send('Page.navigate', { url: `${host.base}${address}` });
      await settled(chrome, `${ready} && ${showing(pane, address)}`);
    }
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await openRoadmapParts(chrome);
      const layout = await readRoadmap(chrome);
      assert.ok(layout.document <= layout.client && layout.body <= layout.client, `${width}: no sideways scroll in the snapshot: ${JSON.stringify(layout)}`);
      await proofShot(chrome, 'snapshot-roadmap', width);
    }
    assert.deepEqual(host.requests.filter((request) => !request.path.startsWith('/demo/') || request.status !== 200), [], 'every request stays in the folder and finds its file');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the export asks for the full board [N26,A2]', { timeout: 90_000 }, // budget: hang-only ceiling for one export and one Chrome open of its item.
  async () => {
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required to open the exported item offline');
    const box = machine();
    const alpha = project(box, 'full-board');
    const criterion = 'The greeting renders from the snapshot alone.';
    box.run(alpha.repo, 'add', 'web', 'Offline greeting', '--specs', 'G1', '--criterion', criterion);
    build(box, alpha, 1, 'greeting.html');
    sendBack(box, alpha, 1, 'the first greeting needs a correction');
    box.run(alpha.web, 'fact', '1', 'measurement', 'The corrected greeting renders offline.');
    build(box, alpha, 1, 'greeting-fix.html');
    accept(box, alpha, 1);

    // The export reads the board through the local API with fetchLocal. Record each address it asks
    // for, never its key, and make every read through fetchLocal unchanged.
    const asked = [];
    /** Note the address of each API read, then read it through the export's own transport. */
    const fetchApi = (url, init) => {
      asked.push(new URL(String(url)));
      return fetchLocal(url, init);
    };
    const folder = join(box.dir, 'full-board-export');
    await exportView(alpha.repo, folder, { fetchApi });
    const stateReads = asked.filter((url) => url.pathname.endsWith('/state'));
    assert.deepEqual(stateReads.map((url) => url.searchParams.get('detail')), ['full'],
      `the export reads the state once, asking for detail=full; it asked for ${asked.map((url) => url.pathname + url.search).join(', ')}`);

    // With no API left to ask, the exported page still opens the item's criterion, verdicts and thread.
    const host = await serveFolder(folder, '/demo/');
    let chrome;
    try {
      chrome = await openSnapshotChrome(executable, `${host.base}/demo/#items/1`, join(box.dir, 'full-board-chrome'));
      await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length && view.item === 1 && !!document.querySelector('#detail .tl')");
      const opened = await chrome.stable(`(() => {
        const detail = document.querySelector('#detail');
        const part = (name) => [...detail.querySelectorAll('h3')].find((heading) => heading.textContent === name)?.parentElement;
        return {
          title: detail.querySelector('h2').innerText,
          criterion: part('Criterion')?.querySelector('.text').innerText ?? null,
          verdicts: [...(part('Verdicts')?.querySelectorAll('.verdict') ?? [])].map((verdict) => [verdict.classList.contains('yes') ? 'ACCEPT' : 'REJECT', verdict.querySelector('.note').innerText]),
          moves: [...detail.querySelectorAll('.tl > li:not(.tl-fact) b')].map((move) => move.textContent),
          facts: [...detail.querySelectorAll('.tl > .tl-fact .tl-body')].map((fact) => fact.textContent),
        };
      })()`);
      assert.ok(opened.title.includes('Offline greeting'), `the address opens item #1: ${opened.title}`);
      assert.equal(opened.criterion, criterion, 'the exported item shows its criterion');
      assert.deepEqual(opened.verdicts, [['REJECT', 'the first greeting needs a correction'], ['ACCEPT', 'the page shows it']],
        'the exported item shows both verdicts with their notes');
      assert.deepEqual(opened.moves, ['add', 'claim', 'proof-run', 'submit', 'reject', 'claim', 'proof-run', 'submit', 'accept'], 'the exported thread shows every move including native proof receipts');
      assert.deepEqual(opened.facts, ['The corrected greeting renders offline.'], 'the exported thread shows its fact');
      assert.ok(host.requests.some((request) => request.path.endsWith('/state.json')), 'the page reads the exported state file');
      assert.deepEqual(host.requests.filter((request) => !request.path.startsWith('/demo/') || request.status !== 200), [],
        'every request stays in the exported folder and finds its file');
      assert.deepEqual(chrome.requests.map((request) => request.url).filter((url) => !url.startsWith(`${host.base}/demo/`) && !url.startsWith('data:')), [],
        'the page asks nothing outside the exported folder');
      assert.deepEqual(chrome.exceptions, [], 'the exported page opens the item without browser exceptions');
    } finally {
      if (chrome) await closeSnapshotChrome(chrome);
      await host.close();
    }
  });
