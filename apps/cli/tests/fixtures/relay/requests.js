/** Shared helpers for the paired-Chrome person-request journeys: sign-in, sealed transport and request polling [H12,H16,B26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
} from 'node:fs';
import {
  writeFileSync,
} from 'node:fs';
import {
  loadavg,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  performance,
} from 'node:perf_hooks';
import {
  test,
} from 'node:test';
import {
  relayWorkBudgetMs,
} from './browser.js';
import {
  cliChildDeadlineMs,
} from './client.js';
export const CHROME_START_BUDGET_MS = relayWorkBudgetMs(2);
export const CLI_SETUP_MARGIN_MS = relayWorkBudgetMs(0);
export const FIXTURE_SETUP_CLI_CHILDREN = [
  { command: ['init'], snapshotUploads: 0 },
  { command: ['add'], snapshotUploads: 0 },
  { command: ['export'], snapshotUploads: 0 },
];
export const APPROVAL_FLOW_CLI_CHILDREN = [
  ...FIXTURE_SETUP_CLI_CHILDREN,
  { command: ['add'], snapshotUploads: 0 },
  { command: ['relay', 'on'], snapshotUploads: 1 },
  { command: ['status'], snapshotUploads: 4 },
  { command: ['export'], snapshotUploads: 0 },
  { command: ['resume'], snapshotUploads: 0 }, // Resume reads indexed health; scheduled sentinel run publishes new findings (#1042).
  { command: ['spec', 'apply'], snapshotUploads: 1 },
  { command: ['answer'], snapshotUploads: 1 },
  { command: ['status'], snapshotUploads: 3 },
  { command: ['export'], snapshotUploads: 0 },
  { command: ['add'], snapshotUploads: 0 },
  { command: ['export'], snapshotUploads: 0 },
];
export const DECLINE_FLOW_CLI_CHILDREN = [
  ...FIXTURE_SETUP_CLI_CHILDREN,
  { command: ['add'], snapshotUploads: 0 },
  { command: ['relay', 'on'], snapshotUploads: 1 },
  { command: ['status'], snapshotUploads: 4 },
  { command: ['answer'], snapshotUploads: 0 }, // The reasonless decline is refused before any change, so it publishes no checkpoint.
  { command: ['answer'], snapshotUploads: 1 },
  { command: ['resume'], snapshotUploads: 0 }, // Resume reads indexed health; scheduled sentinel run publishes new findings (#1042).
];

/** Record the real phase and wait budget for a late-snapshot failure without changing either wait. */
export function lateSnapshotTiming(t) {
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

/** Budget all actual CLI children in a flow, plus one Chrome launch and stated setup margin. */
export function approvalFlowTimeoutMs(cliChildren) {
  const childrenBudgetMs = cliChildren.reduce((total, child) => total + cliChildDeadlineMs(child.snapshotUploads), 0);
  return CHROME_START_BUDGET_MS + childrenBudgetMs + CLI_SETUP_MARGIN_MS;
}

/** Install the fixture's person session without exposing its cookie in browser diagnostics. */
export async function signIn(chrome, box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true, 'the real person session is installed in the isolated browser');
}

/**
 * Wait for the loaded page's board, select Items as a person does, then wait for the item.
 * Why: pages open on the Dashboard and draw only the chosen tab, so the item list exists only once Items is selected.
 */
export async function showItem(chrome, title, previousDocument) {
  await chrome.waitFor('performance.timeOrigin !== ' + JSON.stringify(previousDocument)
    + ' && document.readyState === "complete" && typeof data === "object" && !!data?.project');
  await chrome.click("document.querySelector('[data-tab=items]')");
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
}

/** Pair a real browser and retain the transport already owned by its cockpit. */
export async function pairedTransport(chrome, box, title, timing = null) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  timing?.begin('person session sign-in', relayWorkBudgetMs());
  await signIn(chrome, box);
  timing?.finish();
  timing?.begin('Chrome navigation', relayWorkBudgetMs());
  const previousDocument = await chrome.stable('performance.timeOrigin');
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  timing?.finish();
  timing?.begin('page readiness', relayWorkBudgetMs());
  await showItem(chrome, title, previousDocument);
  timing?.finish();
  await installRequestTransport(chrome, timing);
  return link;
}

/** Attach a transport handle for the existing test actions after either pairing or a reload. */
export async function installRequestTransport(chrome, timing = null) {
  timing?.begin('page transport readiness', relayWorkBudgetMs());
  await chrome.waitFor('typeof transport?.request === "function"', relayWorkBudgetMs(), 'real page transport ready');
  assert.equal(await chrome.stable(`(() => { window.__personRequestTransport = transport;
    return window.__personRequestTransport === transport; })()`), true,
    'fixture commands use the page-owned transport and its single stream queue');
  timing?.finish();
}

/** Send one exact person intent through the browser transport rather than constructing a move. */
export async function sendPersonIntent(chrome, board, move) {
  const path = '/api/v1/boards/' + board + '/moves';
  const task = await chrome.startTask('window.__personRequestTransport.request('
    + JSON.stringify(path) + ',' + JSON.stringify(move) + ')', 'send person request');
  return chrome.pollTask(task, relayWorkBudgetMs(), 'send person request');
}

/** Poll the browser's authenticated, device-decrypted presentation for one durable receipt. */
export async function waitForRequest(chrome, board, id, status, requireCoordinatorRequest = false) {
  const path = '/api/v1/boards/' + board + '/state';
  const predicate = `(() => { const row = documentValue.state?.personRequests?.find(entry => entry.id === ${JSON.stringify(id)}); return row?.status === ${JSON.stringify(status)}${requireCoordinatorRequest ? ' && Number.isSafeInteger(row.coordinatorRequest)' : ''}; })()`;
  // Share the native command, bounded snapshot attempts and scheduling allowance.
  const task = await chrome.startTask(`(async () => {
    const deadline = Date.now() + ${relayWorkBudgetMs()};
    while (Date.now() < deadline) {
      try {
        const documentValue = await window.__personRequestTransport.request(${JSON.stringify(path)});
        if (${predicate}) return documentValue;
      } catch { /* The native checkpoint may still be arriving. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The native person request did not reach the expected status.');
  })()`, 'wait for person request status');
  return chrome.pollTask(task, relayWorkBudgetMs() + relayWorkBudgetMs(0), 'wait for person request status');
}

/** Read final request state by starting the fetch in the page and polling its completion. */
export async function finalState(chrome, board) {
  const task = await chrome.startTask('window.__personRequestTransport.request('
    + JSON.stringify('/api/v1/boards/' + board + '/state') + ')', 'read final person request state');
  return chrome.pollTask(task, relayWorkBudgetMs(), 'read final person request state');
}

/** Add a private pending spec row without changing shared or submitted repository files. */
export function addPendingSpecRow(box, id) {
  const path = join(box.root, 'SPEC.md');
  const original = readFileSync(path, 'utf8');
  assert.equal(original.includes(id + ' ['), false, 'the synthetic row id is unused');
  writeFileSync(path, original + `\n## Person request fixture\n\n- ${id} [pending, aim] Person requests wait for coordinator application. | gate: review\n`);
  return { path, original };
}

