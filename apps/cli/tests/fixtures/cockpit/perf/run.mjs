/*
# Cockpit performance harness

Run a repeatable local sample with:

```sh
node apps/cli/tests/fixtures/cockpit/perf/run.mjs --seed pullboard-perf-606 --size 3000 --runs 5 --idle 30 --live-every 5
```

Add `--projects 8` to register eight separate boards in the fixture's isolated home. The requested `--size` still describes the measured stress board; the other projects are lightweight initialized boards. The JSON records `projects` and the actual sidebar `projectNames`. Multi-project runs add `switchProject`: after an unmeasured visit to another board, it measures the real click back to the stress board. The original eleven actions stay intact, and the default one-project run has no switch sample.

The harness holds the shared browser-capable gate slot across fixture setup and measurement, creates a disposable board and machine home, starts the normal local view server, and uses an isolated real Chrome profile with real pointer and keyboard input. It measures first load, each cockpit tab, opening a small item and the longest-history item, search typing, and a 30-second idle interval while one board API writer adds a shout every five seconds. It reports each action's median and worst stable-paint time, counts Long Tasks longer than 50ms, and records resource request sizes. Unsupported Long Task observation is reported as unavailable rather than as zero tasks. The harness records measurements without applying a performance pass/fail threshold.

The default size follows the measured 605-item board shape and scales its status mix, long histories, event stream, agents, roadmap and spec rows. The generated spec keeps one draft row visible under the cockpit's default "Needs your decision" filter and the remaining rows approved; the status distribution appears in the board manifest and performance report. At the named-test size of 150, all generated roadmap milestones are shipped, so its roadmap action measures the visible, collapsed Shipped disclosure summary rather than expanded upcoming milestone content. The named test uses 150 items to check deterministic generation and action coverage; it does not assert timing values. Use the reported output as a measurement of the specific machine and run conditions, not as a guarantee for other environments.

The generated board, home, machine state and browser profile are temporary after a successful run. Use `--keep` to retain the generated board for inspection; local view keys are kept in process memory and are not included in output. A failed run retains its private board, browser profile and failure summary for diagnosis.
*/
/** Measure each frozen cockpit action on a generated board in an isolated machine and browser profile. */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance as nodePerformance } from 'node:perf_hooks';
import {
  closeBoard,
  shout,
} from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import * as gate from '../../../../../../packages/gate/index.js';
import * as resources from '../../../../../../packages/resources/index.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../chrome.js';
import {
  press,
  stableChrome,
} from '../stable.js';
import {
  generateStressBoard,
  removeStressBoard,
} from './generate.mjs';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../child.js';
import { executionServices } from '../../gate/execution.js';

const ROOT = resolve(import.meta.dirname, '../../../../../..');
const BIN = join(ROOT, 'apps', 'cli', 'pullboard.js');
const ACTION_TIMEOUT_MS = 60_000;
const VIEW_START_TIMEOUT_MS = 30_000;
const VIEW_STOP_TIMEOUT_MS = 5_000;
const LANES = ['core', 'view', 'coordinator', 'docs'];
const VIEWER_ACTIONS = [
  // Shouts opens on its conversation list since 3a98fbee36; a thread's shouts show only after a press.
  ['tab:shouts', 'shouts', '#feed .sx-th, #feed .sx-dayrule'],
  ['tab:spec', 'spec', '#spec-list .row'],
  ['tab:doctrine', 'doctrine', '#doctrine-list .row'],
  ['tab:activity', 'activity', '#activity .act-cols'],
  // Release milestones nest their head in the shared release header since 0ab202b994.
  ['tab:roadmap', 'roadmap', '#roadmap-list > [data-key] .milestone-head'],
  ['tab:items', 'items', '#chain .row'],
];

/** Validate the number of real projects before allocating their private fixtures. */
function projectCount(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('projects must be a positive integer');
  return value;
}

/** Initialize lightweight additional boards in the stress fixture's isolated home through the CLI. */
function registerHarnessProjects(board, projects) {
  for (let index = 1; index < projects; index += 1) {
    const root = join(board.workspace, 'projects', `project-${index + 1}`);
    mkdirSync(root, { recursive: true });
    runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: board.env, encoding: 'utf8' });
    const initialized = runFixtureChild(process.execPath, [BIN, 'init', '--model', 'Stress fixture'],
      { cwd: root, env: board.env, encoding: 'utf8' });
    if (initialized.status !== 0) throw new Error(initialized.failure ?? initialized.stderr);
  }
}

/** Hold the real shared browser pool for fixture setup, Chrome actions and teardown. */
export async function withPerfSlot(action) {
  if (typeof action !== 'function') throw new TypeError('the performance slot needs an action');
  if (typeof resources.gateSlotEnvironment !== 'function') {
    throw new Error('the browser-capable shared gate API is unavailable; merge the current resource-pool update before running the performance harness');
  }
  return gate.withGateSlot(ROOT, async (lease) => {
    const proofEnvironment = resources.gateSlotEnvironment(lease);
    if (lease.browser !== true || proofEnvironment[resources.BROWSER_SLOT_HELD_ENV] !== '1') {
      throw new Error('the performance harness needs a live browser-capable shared gate slot');
    }
    return action((options) => runPerfHarnessInSlot(options, lease));
  }, { executionServices, browser: true, item: '606', kind: 'cockpit-performance' });
}

/** Install page-side input timestamps, Long Task observation and safe request-size collection. */
function timingScript() {
  return `(() => {
    const state = window.__pb606 = { active: null, marks: Object.create(null), tasks: [] };
    const mark = eventType => event => {
      if (state.active?.eventType === eventType && state.marks[state.active.name] === null) {
        state.marks[state.active.name] = performance.now();
      }
    };
    addEventListener('mousedown', mark('mousedown'), true);
    addEventListener('keydown', mark('keydown'), true);
    try {
      state.longTaskObserver = new PerformanceObserver(list => state.tasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
      state.longTaskObserver.observe({ type: 'longtask', buffered: true });
      state.longTaskObserverStatus = 'available';
    } catch (error) {
      state.longTaskObserverStatus = 'unsupported';
      state.longTaskObserverError = error?.name ?? 'unknown';
    }
    performance.setResourceTimingBufferSize(10000);
    window.__pb606Begin = (name, eventType) => { state.active = { name, eventType }; state.marks[name] = null; };
    window.__pb606Collect = (name, startAt, endAt, stable) => {
      state.tasks.push(...(state.longTaskObserver?.takeRecords() ?? []).map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
      const tasks = state.tasks.filter(entry => entry.startTime < endAt && entry.startTime + entry.duration > startAt && entry.duration > 50)
        .map(entry => ({ startMs: entry.startTime - startAt, durationMs: entry.duration }));
      return { name, stable, startMs: startAt, endMs: endAt, durationMs: endAt - startAt,
        longTaskObserverStatus: state.longTaskObserverStatus,
        longTaskObserverError: state.longTaskObserverError ?? null,
        longTasks: tasks,
        largestLongTaskMs: state.longTaskObserverStatus === 'available' ? Math.max(0, ...tasks.map(entry => entry.durationMs)) : null,
        timeOrigin: performance.timeOrigin,
        longTaskObserverUnavailable: state.longTaskObserverStatus !== 'available' };
    };
  })()`;
}

/** Select the exact page target opened by the Chrome fixture, never another blank tab. */
export function selectNetworkTarget(targets, targetId) {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new Error('Chrome did not identify the page target for local network observation');
  }
  const target = targets.find((entry) => entry.id === targetId);
  if (!target || target.type !== 'page' || target.url !== 'about:blank'
      || typeof target.webSocketDebuggerUrl !== 'string') {
    throw new Error('Chrome page target for local network observation was not listed');
  }
  return target;
}

/** Refuse required page-load/live-write samples that captured no actual response bytes. */
export function assertRequiredNetworkEvidence(name, requests, requestBytes) {
  if ((name === 'firstLoad' || name === 'idleWithLiveWrites')
      && (requests.length === 0 || !Number.isSafeInteger(requestBytes) || requestBytes <= 0)) {
    throw new Error(`${name} local network observation is unavailable: no encoded response bytes were captured`);
  }
}

/** Attach a private CDP observer that retains local request paths and actual encoded response byte counts. */
export async function openNetworkCapture(profile, localOrigin, targetId) {
  const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('isolated Chrome did not publish a valid local DevTools port');
  const targetsResponse = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
  if (!targetsResponse.ok) throw new Error('isolated Chrome did not return its local page target');
  const targets = await targetsResponse.json();
  const target = selectNetworkTarget(targets, targetId);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const records = [];
  const active = new Map();
  const commands = new Map();
  let nextCommand = 0;
  let closed = false;
  let observerError = null;
  /** Poison the capture and reject every pending command after transport/protocol failure. */
  const failObserver = (message) => {
    if (observerError || closed) return;
    observerError = new Error(message);
    for (const [id, pending] of commands) {
      clearTimeout(pending.timer);
      pending.reject(observerError);
      commands.delete(id);
    }
  };
  const opened = new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error('local Chrome network observer did not connect')), 5_000); // budget: five-second hang ceiling for observer setup, not action performance.
    socket.addEventListener('open', () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); rejectOpen(new Error('local Chrome network observer failed to connect')); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timeout); rejectOpen(new Error('local Chrome network observer closed before connecting')); }, { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch {
      failObserver('local Chrome network observer received an invalid message');
      return;
    }
    if (message.id !== undefined) {
      const pending = commands.get(message.id);
      if (!pending) return;
      if (message.error) {
        failObserver('local Chrome network observation command failed');
        return;
      }
      commands.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'Network.requestWillBeSent') {
      if (params.redirectResponse) {
        const redirected = active.get(params.requestId);
        if (redirected) {
          redirected.status = params.redirectResponse.status ?? null;
          redirected.responseBytes = Number.isFinite(params.redirectResponse.encodedDataLength)
            ? params.redirectResponse.encodedDataLength : redirected.receivedBytes;
          redirected.complete = true;
          redirected.redirect = true;
          redirected.finishedWallTimeMs = Number.isFinite(params.timestamp) && Number.isFinite(redirected.startTimestamp)
            ? redirected.startWallTimeMs + (params.timestamp - redirected.startTimestamp) * 1_000 : null;
        }
      }
      let url;
      try { url = new URL(params.request?.url); } catch { active.delete(params.requestId); return; }
      if (url.origin !== localOrigin) { active.delete(params.requestId); return; }
      const request = { path: url.pathname, method: params.request?.method ?? 'OTHER', type: params.type ?? 'Other',
        startWallTimeMs: Number.isFinite(params.wallTime) ? params.wallTime * 1_000 : null,
        startTimestamp: params.timestamp ?? null, status: null, responseBytes: null, receivedBytes: 0,
        chunks: [], complete: false, failed: false };
      records.push(request);
      active.set(params.requestId, request);
      return;
    }
    const request = active.get(params.requestId);
    if (!request) return;
    if (message.method === 'Network.responseReceived') request.status = params.response?.status ?? null;
    if (message.method === 'Network.dataReceived' && Number.isFinite(params.encodedDataLength)) {
      request.receivedBytes += params.encodedDataLength;
      request.chunks.push({ atWallTimeMs: Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? request.startWallTimeMs + (params.timestamp - request.startTimestamp) * 1_000 : null,
      bytes: params.encodedDataLength });
    }
    if (message.method === 'Network.loadingFinished') {
      request.responseBytes = Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : request.receivedBytes;
      request.complete = true;
      request.finishedWallTimeMs = Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? request.startWallTimeMs + (params.timestamp - request.startTimestamp) * 1_000 : null;
      request.durationMs = Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? Math.max(0, (params.timestamp - request.startTimestamp) * 1_000) : null;
      active.delete(params.requestId);
    }
    if (message.method === 'Network.loadingFailed') {
      request.responseBytes = request.receivedBytes;
      request.complete = true;
      request.failed = true;
      request.finishedWallTimeMs = Number.isFinite(params.timestamp) && Number.isFinite(request.startTimestamp)
        ? request.startWallTimeMs + (params.timestamp - request.startTimestamp) * 1_000 : null;
      active.delete(params.requestId);
    }
  });
  socket.addEventListener('error', () => failObserver('local Chrome network observer failed after connecting'));
  socket.addEventListener('close', () => failObserver('local Chrome network observer closed before capture completed'));
  const send = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    if (observerError) return rejectCommand(observerError);
    if (closed) return rejectCommand(new Error('local Chrome network observer is closed'));
    const id = ++nextCommand;
    const timer = setTimeout(() => { // budget: five-second hang ceiling for a stalled local DevTools command.
      failObserver('local Chrome network observation command timed out');
    }, 5_000);
    commands.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    try { socket.send(JSON.stringify({ id, method, params })); } catch {
      failObserver('local Chrome network observer could not send a command');
    }
  });
  try {
    await opened;
    await send('Network.enable');
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    targetId,
    assertAvailable() {
      if (observerError) throw observerError;
      if (closed) throw new Error('local Chrome network observer is closed');
    },
    snapshot(name, startMs, endMs, timeOrigin) {
      this.assertAvailable();
      const firstLoad = name === 'firstLoad';
      const requests = records.map((request) => {
        if (!Number.isFinite(request.startWallTimeMs)) return false;
        const relative = request.startWallTimeMs - timeOrigin;
        const beganInAction = (firstLoad ? relative >= -5_000 : relative >= startMs) && relative <= endMs;
        const chunks = request.chunks.filter((chunk) => Number.isFinite(chunk.atWallTimeMs)
          && chunk.atWallTimeMs - timeOrigin >= startMs && chunk.atWallTimeMs - timeOrigin <= endMs);
        if (!beganInAction && !chunks.length) return null;
        const completedDuringAction = Number.isFinite(request.finishedWallTimeMs)
          && request.finishedWallTimeMs - timeOrigin >= startMs && request.finishedWallTimeMs - timeOrigin <= endMs;
        const completedForFirstLoad = firstLoad && request.complete && !request.failed
          && Number.isFinite(request.finishedWallTimeMs) && request.finishedWallTimeMs - timeOrigin <= endMs;
        const responseBytes = completedForFirstLoad || (beganInAction && request.complete && completedDuringAction)
          ? request.responseBytes : chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
        return { path: request.path, method: request.method, type: request.type, status: request.status,
          responseBytes, complete: request.complete, failed: request.failed,
          startMs: relative - startMs, durationMs: request.durationMs ?? null };
      }).filter(Boolean);
      const requestBytes = requests.reduce((sum, request) => sum + (Number.isSafeInteger(request.responseBytes) ? request.responseBytes : 0), 0);
      assertRequiredNetworkEvidence(name, requests, requestBytes);
      return { requests, requestBytes,
        incompleteRequests: requests.filter((request) => !request.complete).length };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const pending of commands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('local Chrome network observer closed'));
      }
      commands.clear();
      socket.close();
    },
  };
}

/** Wait for the browser condition and named target through the shared measurement boundary. */
async function waitPaintedAndStable(chrome, network, name, selector, condition, firstLoad = false) {
  const target = `document.querySelector(${JSON.stringify(selector)})`;
  const ready = `(() => {
    const node = ${target}, style = node && getComputedStyle(node), rect = node?.getBoundingClientRect();
    return !!node && !!rect && !node.closest('[hidden]') && !document.body.classList.contains('switching')
      && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (${condition});
  })()`;
  try {
    await chrome.waitFor(ready, ACTION_TIMEOUT_MS); // budget: 60-second hang ceiling for an unreachable UI condition, not a speed bar.
  } catch (error) {
    // Name what the page held when the hang ceiling hit, so a never-ready target is read from the run's own log.
    const held = await chrome.stable(`(() => ({ tab: view.tab, root: view.root, dataRoot: data?.root, on: [...document.querySelectorAll('.tab.on')].map(node => node.dataset.tab),
      paneHidden: document.querySelector('[data-pane="' + view.tab + '"]')?.hidden, target: document.querySelector(${JSON.stringify(selector)}) ? 1 : 0,
      body: document.body.className, address: location.pathname + location.hash }))()`)
      .catch((reason) => ({ unread: String(reason) }));
    throw new Error(`${error.message}; the page held ${JSON.stringify(held)}`, { cause: error });
  }
  const startAt = firstLoad ? '0' : `window.__pb606?.marks[${JSON.stringify(name)}]`;
  const expression = `(() => {
    const node = ${target}, style = node && getComputedStyle(node), rect = node?.getBoundingClientRect();
    const ready = !!node && !!rect && !node.closest('[hidden]') && !document.body.classList.contains('switching')
      && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (${condition});
    if (!ready) throw new Error('the named target or browser condition stopped being ready');
    const startAt = ${startAt};
    if (!Number.isFinite(startAt)) throw new Error('the measured input event was not observed');
    const endAt = performance.now();
    return window.__pb606Collect(${JSON.stringify(name)}, startAt, endAt, true);
  })()`;
  const measurement = await chrome.stable(expression, target);
  return { ...measurement, ...network.snapshot(name, measurement.startMs, measurement.endMs, measurement.timeOrigin) };
}

/** Give the browser a bounded wait without leaving a timer after the requested idle window. */
function pause(ms) {
  return new Promise((resolvePause) => setTimeout(resolvePause, ms)); // budget: the required idle observation lasts exactly the configured 30000ms by default.
}

/** Keep useful startup diagnostics while removing URL credentials and query secrets. */
function safeStartupDiagnostic(stderr) {
  return stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/https?:\/\/[^\s"'<>]+/gu, (value) => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        if (url.search) url.search = '?[redacted]';
        if (url.hash) url.hash = '#[redacted]';
        return url.href;
      } catch {
        return '[redacted URL]';
      }
    })
    .replace(/((?:token|secret|key|credential|authorization)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .trim()
    .slice(-2_048);
}

/** Start the generated board's foreground view server without exposing its local key in diagnostics. */
export async function startView(board) {
  const env = { ...board.env, PULLBOARD_VIEW_FOREGROUND: '1' };
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0'], {
    cwd: board.root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let spawnError = null;
  let closeResult = null;
  const closed = new Promise((resolveClosed) => child.once('close', (code, signal) => {
    closeResult = { code, signal };
    resolveClosed(closeResult);
  }));
  child.once('error', (error) => { spawnError = error; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_384); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
  const deadline = Date.now() + VIEW_START_TIMEOUT_MS;
  while (Date.now() < deadline && !spawnError && !closeResult) {
    const match = /Pullboard view: (http:\/\/127\.0\.0\.1:\d+\/\?k=[^\s]+)/u.exec(output);
    if (match) return { child, closed, link: new URL(match[1]), stderr: () => stderr };
    await pause(25); // budget: polling bounds discovery of the fixture server URL, not product speed.
  }
  await stopView({ child, closed });
  const diagnostic = safeStartupDiagnostic(stderr);
  throw new Error(`the isolated view did not publish a local link within ${VIEW_START_TIMEOUT_MS}ms${spawnError ? `; child could not start: ${spawnError.message}` : closeResult ? `; it exited with status ${closeResult.code ?? 'null'}` : ''}${diagnostic ? `; stderr: ${diagnostic}` : ''}`);
}

/** Stop the one view process started by this harness and wait for its direct child to close. */
export async function stopView(view) {
  if (view.child.exitCode === null && view.child.signalCode === null) {
    try { view.child.kill('SIGTERM'); } catch { /* The owned CLI process may have exited between the check and signal. */ }
  }
  const waitForClose = async (timeoutMs) => {
    let timer;
    const result = await Promise.race([view.closed.then(() => true), new Promise((resolveClose) => {
      timer = setTimeout(() => resolveClose(false), timeoutMs);
    })]);
    clearTimeout(timer);
    return result;
  };
  const result = await waitForClose(VIEW_STOP_TIMEOUT_MS); // budget: five-second hang ceiling for owned-view shutdown before escalation.
  if (!result) {
    try { view.child.kill('SIGKILL'); } catch { /* The owned CLI process may have exited before escalation. */ }
    const killed = await waitForClose(VIEW_STOP_TIMEOUT_MS); // budget: five-second hang ceiling for cleanup after owned-view escalation.
    if (!killed) throw new Error('the isolated view did not close after bounded cleanup');
  }
}

/** Record one real CDP key event so the search action includes its actual typing cadence. */
async function typeKey(chrome, value) {
  const code = `Key${value.toUpperCase()}`;
  const keyCode = value.toUpperCase().charCodeAt(0);
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, windowsVirtualKeyCode: keyCode, text: value, unmodifiedText: value });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode: keyCode });
}

/** Scroll the Items list so a row far down is drawn: the list draws only the rows near the screen (#6676), as a person would scroll to it. */
async function scrollRowIntoView(chrome, id) {
  await chrome.stable(`(() => {
    const index = itemsList.shown.findIndex(item => item.id === ${id});
    if (index < 0) throw new Error('item ${id} is not in the shown Items list');
    const chain = document.querySelector('#chain');
    window.scrollTo(0, Math.max(0, chain.getBoundingClientRect().top + window.scrollY + index * itemsPitch - innerHeight / 3));
    return true;
  })()`);
  await chrome.waitFor(`!!document.querySelector('#chain .row[data-item="${id}"]')`);
}

/** Begin measuring the next native input of the requested type without including setup waits. */
async function beginAction(chrome, name, eventType) {
  await chrome.stable(`window.__pb606Begin(${JSON.stringify(name)}, ${JSON.stringify(eventType)})`);
}

/** Capture one run's first load, six tabs, two item opens, search and live idle interval. */
async function measureRun(board, runIndex, executable, idleMs, liveEveryMs, projects) {
  const measuredRoot = realpathSync(board.root);
  const profile = join(board.workspace, `chrome-${runIndex + 1}`);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  let view = null;
  let chrome = null;
  let network = null;
  let measurementError = null;
  const actions = [];
  try {
    view = await startView(board);
    chrome = await stableChrome(await startChrome({ url: 'about:blank', executable, profileDirectory: profile,
      commandTimeoutMs: ACTION_TIMEOUT_MS, taskTimeoutMs: ACTION_TIMEOUT_MS,
      env: { HOME: profile, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'en_US.UTF-8' } }));
    const targetResult = await chrome.send('Target.getTargetInfo', {}, 'identify the isolated Chrome page', ACTION_TIMEOUT_MS);
    const targetId = targetResult?.targetInfo?.targetId;
    if (typeof targetId !== 'string' || targetId.length === 0 || targetResult?.targetInfo?.type !== 'page') {
      throw new Error('isolated Chrome did not identify its page target before navigation');
    }
    network = await openNetworkCapture(chrome.profileDirectory, view.link.origin, targetId);
    actions.networkTargetId = network.targetId;
    await chrome.send('Network.setCacheDisabled', { cacheDisabled: true }, 'disable the fresh profile cache', ACTION_TIMEOUT_MS);
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: timingScript() }, 'install performance observers', ACTION_TIMEOUT_MS);
    const browserVersion = await chrome.send('Browser.getVersion', {}, 'pin the isolated browser runtime', ACTION_TIMEOUT_MS);
    // The board lands on the dashboard since 0531f8f686 retired Home; the first load measures the Items address.
    const itemsLink = new URL(view.link.href);
    itemsLink.pathname = '/items';
    await chrome.navigate(itemsLink.href);
    actions.push(await waitPaintedAndStable(chrome, network, 'firstLoad', '#chain .row',
      `document.readyState === 'complete' && !document.body.classList.contains('loading') && view.root === ${JSON.stringify(measuredRoot)}`, true));

    const listed = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#proj-list .repo[data-root]')]
      .map(node => ({ root: node.dataset.root, name: node.querySelector('.pname')?.textContent })))`));
    if (listed.length !== projects || listed.some(project => typeof project.name !== 'string')) {
      throw new Error(`the view listed ${listed.length} projects; expected ${projects} initialized boards`);
    }
    actions.projectNames = listed.map(project => project.name);
    if (projects > 1) {
      const other = listed.find(project => project.root !== measuredRoot);
      if (!other) throw new Error('the project-switch sample needs another registered board');
      // press reaches a row in the closed project list through the switcher itself, as a person does.
      /** Find the listed project without interpolating fixture paths into a CSS selector. */
      const row = root => `[...document.querySelectorAll('#proj-list .repo[data-root]')].find(node => node.dataset.root === ${JSON.stringify(root)})`;
      await beginAction(chrome, 'switchProjectSetup', 'mousedown');
      await press(chrome, row(other.root));
      await waitPaintedAndStable(chrome, network, 'switchProjectSetup', '#status-board',
        `view.root === ${JSON.stringify(other.root)} && data?.root === ${JSON.stringify(other.root)}`);
      await beginAction(chrome, 'switchProject', 'mousedown');
      await press(chrome, row(measuredRoot));
      actions.push(await waitPaintedAndStable(chrome, network, 'switchProject', '#chain .row',
        `view.root === ${JSON.stringify(measuredRoot)} && data?.root === ${JSON.stringify(measuredRoot)}`));
    }

    for (const [name, tab, target] of VIEWER_ACTIONS) {
      await beginAction(chrome, name, 'mousedown');
      await press(chrome, `document.querySelector('[data-tab="${tab}"]')`);
      actions.push(await waitPaintedAndStable(chrome, network, name, target,
        `document.querySelector('.tab.on')?.dataset.tab === ${JSON.stringify(tab)}`));
    }

    await scrollRowIntoView(chrome, board.smallItemId);
    const smallRow = `document.querySelector('#chain .row[data-item="${board.smallItemId}"]')`;
    await beginAction(chrome, 'openSmallItem', 'mousedown');
    await press(chrome, smallRow);
    // An item opens in the redesigned item panel since 639c16dbb5.
    actions.push(await waitPaintedAndStable(chrome, network, 'openSmallItem', '#detail .item-panel',
      `view.item === ${board.smallItemId} && document.querySelector('#detail .item-panel-head h2')?.textContent.includes(${JSON.stringify(board.smallItemTitle)})`));

    await scrollRowIntoView(chrome, board.longestHistoryItemId);
    const longRow = `document.querySelector('#chain .row[data-item="${board.longestHistoryItemId}"]')`;
    await beginAction(chrome, 'openLongestHistoryItem', 'mousedown');
    await press(chrome, longRow);
    actions.push(await waitPaintedAndStable(chrome, network, 'openLongestHistoryItem', '#detail .item-panel',
      `view.item === ${board.longestHistoryItemId} && document.querySelector('#detail .item-panel-head h2')?.textContent.includes(${JSON.stringify(board.longestHistoryTitle)})`));

    await press(chrome, "document.querySelector('#q')");
    await beginAction(chrome, 'search', 'keydown');
    for (const character of 'Small') {
      await typeKey(chrome, character);
      await pause(90); // budget: reproduce the measured person's 90ms key cadence; the search sample starts at the first keydown.
    }
    // Search opens the command palette (f3505cc3a2): the typed words land in #pal-q and its rows are the results.
    actions.push(await waitPaintedAndStable(chrome, network, 'search', '#pal-overlay .pal-r',
      `document.querySelector('#pal-q')?.value === 'Small' && !!document.querySelector('#pal-overlay .pal-r')`));
    await chrome.stable("(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()");

    await beginAction(chrome, 'idleSetup', 'mousedown');
    await press(chrome, "document.querySelector('[data-tab=\"shouts\"]')");
    // Older threads fold under Earlier, so the tab is ready on a row or the fold.
    // A live shout updates its conversation row's preview, so the feed's text still shows each write as it lands.
    await waitPaintedAndStable(chrome, network, 'idleSetup', '#feed .sx-th, #feed .sx-dayrule',
      `document.querySelector('.tab.on')?.dataset.tab === 'shouts'`);
    const liveMessages = Array.from({ length: Math.ceil(idleMs / liveEveryMs) }, (_, index) =>
      `Live stress update ${index + 1} for seed ${board.seed}, run ${runIndex + 1}.`);
    await chrome.stable(`(() => {
      const feed = document.querySelector('#feed');
      if (!feed) throw new Error('the shouts feed is unavailable for the live observation');
      window.__pb606IdleExpected = new Map(${JSON.stringify(liveMessages)}.map(text => [text, null]));
      const scan = () => {
        const text = feed.textContent;
        for (const [message, at] of window.__pb606IdleExpected) {
          if (at === null && text.includes(message)) window.__pb606IdleExpected.set(message, performance.now());
        }
      };
      window.__pb606IdleScan = scan;
      window.__pb606IdleObserver = new MutationObserver(scan);
      window.__pb606IdleObserver.observe(feed, { childList: true, subtree: true, characterData: true });
      scan();
      if ([...window.__pb606IdleExpected.values()].some(at => at !== null)) {
        throw new Error('a live update marker was already present before this idle sample');
      }
      })()`, "document.querySelector('#shouts-threads')");
    let liveBoard = null;
    let liveWrites = 0;
    const idleStart = await chrome.stable('performance.now()', "document.querySelector('#shouts-threads')");
    const wallStart = nodePerformance.now();
    const liveWriteOffsetsMs = [];
    try {
      liveBoard = openBoard(board.boardFile);
      for (let targetMs = 0; targetMs < idleMs; targetMs += liveEveryMs) {
        const delay = wallStart + targetMs - nodePerformance.now();
        if (delay > 0) await pause(delay); // budget: each write remains on a fixed wall-clock cadence inside the 30-second sample.
        const text = liveMessages[liveWrites];
        shout(liveBoard, { from: board.liveWriter, to: 'all', text, lanes: LANES });
        liveWrites += 1;
        liveWriteOffsetsMs.push(nodePerformance.now() - wallStart);
      }
      const remaining = wallStart + idleMs - nodePerformance.now();
      if (remaining > 0) await pause(remaining); // budget: retain the full 30-second idle observation after the sixth write.
    } finally {
      if (liveBoard) closeBoard(liveBoard);
    }
    // Under load the last live write's response bytes can land just after the fixed window; wait (bounded, never
    // throwing) until every marker has rendered so the sample holds its bytes. The window's start and checks are unchanged.
    await chrome.stable(`(async () => {
      const deadline = performance.now() + 10000; // budget: ten-second hang ceiling for the render wait, not action performance.
      while (performance.now() < deadline) {
        window.__pb606IdleScan?.();
        if ([...(window.__pb606IdleExpected?.values() ?? [])].every(at => at !== null)) return true;
        await new Promise(resolve => setTimeout(resolve, 50)); // budget: poll tick for the render wait, not action performance.
      }
      return false;
    })()`, "document.querySelector('#shouts-threads')");
    const idle = await chrome.stable(`(() => {
      window.__pb606IdleScan?.();
      const endAt = performance.now();
      const renderedAtMs = [...(window.__pb606IdleExpected ?? new Map())].map(([text, at]) => ({ text, at }));
      const report = window.__pb606Collect('idleWithLiveWrites', ${idleStart}, endAt, true);
      report.renderedWrites = renderedAtMs.filter(({ at }) => Number.isFinite(at) && at <= endAt).length;
      report.renderedAtMs = renderedAtMs.map(({ at }) => Number.isFinite(at) ? at - ${idleStart} : null);
      return report;
    })()`, "document.querySelector('#shouts-threads')");
    idle.liveWriteOffsetsMs = liveWriteOffsetsMs;
    Object.assign(idle, network.snapshot('idleWithLiveWrites', idleStart, idle.endMs, idle.timeOrigin));
    idle.liveWrites = liveWrites;
    actions.push(idle);
    actions.browserVersion = browserVersion;
    network.assertAvailable();
    return actions;
  } catch (error) {
    measurementError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { network?.close(); } catch (error) { cleanupErrors.push(`network observer: ${error.message}`); }
    try { if (chrome) await chrome.close(); } catch (error) { cleanupErrors.push(`Chrome connection: ${error.message}`); }
    try { if (view) await stopView(view); } catch (error) { cleanupErrors.push(`view process: ${error.message}`); }
    if (measurementError || cleanupErrors.length) {
      const failurePath = join(board.workspace, `run-${runIndex + 1}-failure.json`);
      try {
        writeFileSync(failurePath, `${JSON.stringify({ version: 1, run: runIndex + 1,
          error: measurementError?.message ?? 'cleanup failed', cleanupErrors, actions,
          chromeProfile: profile }, null, 2)}\n`, { mode: 0o600 });
      } catch (error) { cleanupErrors.push(`failure record: ${error.message}`); }
      if (measurementError && cleanupErrors.length) measurementError.cleanupErrors = cleanupErrors;
      else if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map((message) => new Error(message)), 'the performance harness cleanup did not finish cleanly');
    }
  }
}

/** Return the median of a nonempty numeric sample. */
function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Summarize action samples without adding any pass/fail latency threshold. */
function summarize(runs) {
  const labels = runs[0].map((entry) => entry.name);
  return labels.map((name) => {
    const samples = runs.map((entries) => entries.find((entry) => entry.name === name));
    const durations = samples.map((entry) => entry.durationMs);
    const statuses = samples.map((entry) => ({ status: entry.longTaskObserverStatus ?? 'unsupported', error: entry.longTaskObserverError ?? null }));
    const allLongTaskSamplesAvailable = statuses.every(({ status }) => status === 'available');
    const longCounts = samples.map((entry, index) => statuses[index].status === 'available' ? entry.longTasks.length : null);
    return { name, medianMs: median(durations), worstMs: Math.max(...durations),
      longTaskStatusPerRun: statuses,
      medianLongTasks: allLongTaskSamplesAvailable ? median(longCounts) : null,
      worstLongTasks: allLongTaskSamplesAvailable ? Math.max(...longCounts) : null,
      largestLongTaskMs: allLongTaskSamplesAvailable ? Math.max(...samples.map((entry) => entry.largestLongTaskMs)) : null,
      requestBytesPerRun: samples.map((entry) => entry.requestBytes),
      requestsPerRun: samples.map((entry) => entry.requests),
      samples };
  });
}

/** Escape a value so a request path cannot add Markdown table cells. */
function escapeTableCell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\r?\n/gu, '<br>');
}

/** Render the action summaries and the individual request bytes recorded in the JSON report. */
function renderTable(actions) {
  const lines = ['| action | median stable ms | worst stable ms | long tasks / run (median, worst) | largest long task ms | request bytes / run | requests by run (method, path, bytes) |',
    '|---|---:|---:|---:|---:|---:|---|'];
  for (const action of actions) {
    const longTaskCount = Number.isFinite(action.medianLongTasks)
      ? `${action.medianLongTasks}, ${action.worstLongTasks}` : 'unavailable';
    const largestLongTask = Number.isFinite(action.largestLongTaskMs) ? action.largestLongTaskMs.toFixed(1) : 'unavailable';
    const requestsByRun = (action.requestsPerRun ?? []).map((requests, index) => {
      const details = requests.length ? requests.map((request) => {
        const bytes = Number.isSafeInteger(request.responseBytes) ? `${request.responseBytes} B` : 'unavailable';
        return `${request.method ?? 'OTHER'} ${request.path ?? '(unknown path)'} = ${bytes}`;
      }).join('; ') : 'no requests';
      return `run ${index + 1}: ${details}`;
    }).join('<br>') || 'unavailable';
    lines.push(`| ${escapeTableCell(action.name)} | ${action.medianMs.toFixed(1)} | ${action.worstMs.toFixed(1)} | ${longTaskCount} | ${largestLongTask} | ${action.requestBytesPerRun.join(', ')} | ${escapeTableCell(requestsByRun)} |`);
  }
  return lines.join('\n');
}

/** Run the user-facing harness with an isolated generated board and headless real Chrome. */
async function runPerfHarnessInSlot({ board, runs = 1, idleMs = 30_000, liveEveryMs = 5_000,
  executable = findChromeExecutable(), projects = 1 } = {}, lease) {
  if (!board?.workspace || !board?.boardFile) throw new TypeError('board must come from generateStressBoard');
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20) throw new RangeError('runs must be an integer from 1 through 20');
  if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 300_000) throw new RangeError('idleMs must be an integer from 0 through 300000');
  if (!Number.isSafeInteger(liveEveryMs) || liveEveryMs < 1_000 || liveEveryMs > 60_000) throw new RangeError('liveEveryMs must be an integer from 1000 through 60000');
  if (!executable) throw new Error('Chrome was not found; install Chrome or set PULLBOARD_CHROME.');
  projectCount(projects);
  registerHarnessProjects(board, projects);
  const capture = async (lease) => {
    const captured = [];
    for (let index = 0; index < runs; index += 1) captured.push(await measureRun(board, index, executable, idleMs, liveEveryMs, projects));
    const actions = summarize(captured);
    const report = { version: 1, seed: board.seed, size: board.size, digest: board.digest,
      projects: captured[0].projectNames.length, projectNames: captured[0].projectNames,
      gate: { browser: lease.browser === true, waitMs: lease.waitMs },
      boardShape: { statuses: board.statusTotals, lanes: board.laneTotals, agents: board.agentCount,
        itemEvents: board.itemEvents, shouts: board.shoutCount, milestones: board.milestoneCount,
        milestoneRows: board.milestoneRows, specRows: board.specRows, specStatuses: board.specStatusTotals }, runs, idleMs, liveEveryMs,
      browser: { input: 'real Chrome through CDP', executable, versions: captured.map(run => run.browserVersion),
        networkTargetIds: captured.map(run => run.networkTargetId) },
      actions, table: renderTable(actions) };
    writeFileSync(join(board.workspace, 'performance-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  };
  return capture(lease);
}

/** Run the complete browser sample while owning the shared browser-capable slot. */
export async function runPerfHarness(options = {}) {
  return withPerfSlot((run) => run(options));
}

/** Parse and execute the standalone command when this file is the program entry point. */
async function main(argv) {
  const parsed = parseArgs({ args: argv, options: {
    seed: { type: 'string', default: 'pullboard-perf-606' }, size: { type: 'string', default: '3000' },
    projects: { type: 'string', default: '1' },
    runs: { type: 'string', default: '5' }, idle: { type: 'string', default: '30' }, 'live-every': { type: 'string', default: '5' },
    keep: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (parsed.values.help) {
    process.stdout.write('Usage: node apps/cli/tests/fixtures/cockpit/perf/run.mjs [--seed text] [--size 3000] [--projects 1] [--runs 5] [--idle 30] [--live-every 5] [--keep]\n');
    return;
  }
  let board = null;
  let completed = false;
  const projects = projectCount(Number(parsed.values.projects));
  try {
    await withPerfSlot(async (run) => {
      board = generateStressBoard({ seed: parsed.values.seed, size: Number(parsed.values.size) });
      try {
        const report = await run({ board, projects, runs: Number(parsed.values.runs), idleMs: Number(parsed.values.idle) * 1_000,
          liveEveryMs: Number(parsed.values['live-every']) * 1_000 });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n${report.table}\n`);
        if (parsed.values.keep) process.stdout.write(`Generated board kept at ${board.root}\n`);
        completed = true;
      } finally {
        if (!parsed.values.keep && completed) removeStressBoard(board);
      }
    });
  } catch (error) {
    if (board && !completed) process.stderr.write(`Performance evidence retained at ${board.workspace}\n`);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
