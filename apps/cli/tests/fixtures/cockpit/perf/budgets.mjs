/**
 * The view's instant-feel budgets (U94), measured in real Chrome on a running pullboard view [N26].
 *
 * A click shows feedback within 50 ms, a tab switch draws within 100 ms, the first item rows paint within
 * 1.5 s on a warm server, and opening the board moves under 500 KB. `measureBudgets` drives the view with real
 * pointer input; `budgetFailures` names each missed budget with its measured value.
 *
 *     node apps/cli/tests/fixtures/cockpit/perf/budgets.mjs --url '<the link pullboard view prints>'
 *
 * measures an already running view (the live board) and exits 1 when a budget is missed.
 */
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  findChromeExecutable,
  startChrome,
} from '../../chrome.js';
import {
  press,
  stableChrome,
} from '../stable.js';
import { openNetworkCapture } from './run.mjs';
import {
  budgetFailures,
  budgetSummary,
} from './budget-check.mjs';

export { BUDGETS, assertBudgets, budgetFailures, budgetSummary } from './budget-check.mjs';

// budget: hang-only ceiling for one measured interaction that never arrives; the budgets above are the bars.
const SAMPLE_TIMEOUT_MS = 30_000;
// budget: hang-only ceiling for the page to show its first rows at all.
const LOAD_TIMEOUT_MS = 60_000;
// The first load counts every byte the page moves until no response has finished for SETTLE_MS after its first
// rows, or SETTLE_CEILING_MS after them on a board busy enough that live updates never stop.
const SETTLE_MS = 3_000;
const SETTLE_CEILING_MS = 10_000;
// Between presses the page settles this long, as a person reading the switched tab would let it.
const BETWEEN_MS = 500;

/** Tabs pressed in order from the Items address, each with the content that proves it drew. */
export const TAB_TARGETS = Object.freeze([
  ['shouts', '#feed .sx-th, #feed .sx-dayrule'],
  ['spec', '#spec-list .row'],
  ['doctrine', '#doctrine-list .row'],
  ['activity', '#activity .act-cols'],
  ['roadmap', '#roadmap-list > [data-key] .milestone-head'],
  ['dashboard', '#dashboard > *'],
  ['items', '#chain .row'],
]);

/**
 * Installed before every document: time the first painted item rows from navigation start, and time each armed
 * press from its real mousedown to the first painted frame showing its feedback and, for tabs, its drawn content.
 * A paint is observed as the task after the frame whose rAF callback first saw the condition.
 */
function pageScript() {
  return `(() => {
    const state = window.__pbBudgets = { firstRowsMs: null, samples: [], next: null };
    performance.setResourceTimingBufferSize(100000);
    /** Resolve once no response has finished and no frame was held for quietMs, or false at the ceiling. */
    state.quiet = async (quietMs, ceilingMs) => {
      const stop = performance.now() + ceilingMs;
      let since = performance.now(), previous = since, seen = 0;
      while (performance.now() < stop) {
        const now = await new Promise(requestAnimationFrame);
        const entries = performance.getEntriesByType('resource');
        if (entries.length !== seen || now - previous > 50) { seen = entries.length; since = now; }
        previous = now;
        if (now - since >= quietMs) return true;
      }
      return false;
    };
    /** Resolve with the last armed sample once it has finished. */
    state.finished = async () => {
      while (!state.samples.at(-1)?.done) await new Promise(requestAnimationFrame);
      return state.samples.at(-1);
    };
    const visible = (node) => { if (!node || node.closest('[hidden]')) return false; const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
    const afterPaint = (record) => { const channel = new MessageChannel(); channel.port1.onmessage = () => record(performance.now()); channel.port2.postMessage(0); };
    const rows = () => {
      if (visible(document.querySelector('#chain .row')) && !document.body.classList.contains('loading')) afterPaint((at) => { state.firstRowsMs = at; });
      else requestAnimationFrame(rows);
    };
    requestAnimationFrame(rows);
    const feedback = (sample) => sample.kind === 'tab'
      ? document.querySelector('.tab.on')?.dataset.tab === sample.tab && visible(document.querySelector('.tab.on'))
      : visible(document.querySelector('#detail h2')) && new RegExp('#' + sample.item + '(?!\\d)').test(document.querySelector('#detail .item-panel-head').textContent);
    const drawn = (sample) => sample.kind !== 'tab' || (typeof view === 'object' && view.tab === sample.tab
      && visible(document.querySelector('[data-pane="' + sample.tab + '"]')) && [...document.querySelectorAll(sample.target)].some(visible));
    addEventListener('mousedown', (event) => {
      if (!state.next) return;
      const sample = { ...state.next, start: event.timeStamp, feedbackMs: null, drawMs: null, done: false };
      state.next = null;
      state.samples.push(sample);
      const ceiling = sample.start + ${SAMPLE_TIMEOUT_MS};
      const frame = () => {
        if (sample.feedbackMs === null && !sample.feedbackSeen && feedback(sample)) { sample.feedbackSeen = true; afterPaint((at) => { sample.feedbackMs = at - sample.start; }); }
        if (sample.kind === 'tab' && sample.drawMs === null && !sample.drawSeen && drawn(sample)) { sample.drawSeen = true; afterPaint((at) => { sample.drawMs = at - sample.start; }); }
        const finished = sample.feedbackSeen && (sample.kind !== 'tab' || sample.drawSeen);
        if (finished || performance.now() > ceiling) { afterPaint(() => { sample.done = true; }); return; }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, true);
  })()`;
}

/** Wait in the page until it has been quiet for quietMs, or ceilingMs; true when it went quiet. */
function settle(chrome, quietMs, ceilingMs = SETTLE_CEILING_MS) {
  return chrome.stable(`window.__pbBudgets.quiet(${quietMs}, ${ceilingMs})`);
}

/** Press one target with real pointer input and return its finished sample. */
async function measuredPress(chrome, find, sample) {
  await chrome.stable(`window.__pbBudgets.next = ${JSON.stringify(sample)}`, find);
  await press(chrome, find);
  // The sample ends itself at its hang ceiling, so this in-page wait always resolves.
  const measured = await chrome.stable('window.__pbBudgets.finished()');
  await settle(chrome, BETWEEN_MS);
  return measured;
}

/**
 * Drive a running view at `link` through the four budgets and return what it measured.
 * @param {URL} link - The view link, with its key, as `pullboard view` prints it.
 * @param {{ profile?: string, executable?: string }} [options]
 */
export async function measureBudgets(link, { profile, executable = findChromeExecutable() } = {}) {
  if (!executable) throw new Error('Chrome is required for the view speed check');
  const itemsLink = new URL(link.href);
  itemsLink.pathname = '/items';
  let chrome, network;
  try {
    // Without a profile, startChrome owns a private one and removes it on close.
    chrome = await stableChrome(await startChrome({ url: 'about:blank', executable, profileDirectory: profile,
      commandTimeoutMs: LOAD_TIMEOUT_MS, taskTimeoutMs: LOAD_TIMEOUT_MS,
      env: { HOME: profile ?? process.env.HOME, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'en_US.UTF-8' } }));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: pageScript() });
    const rowsShown = "window.__pbBudgets?.firstRowsMs !== null && window.__pbBudgets?.firstRowsMs !== undefined";

    // Warm the server: one full open of the board, then leave it.
    await chrome.navigate(itemsLink.href);
    await chrome.waitFor(rowsShown, LOAD_TIMEOUT_MS); // budget: 60-second hang ceiling for a board that never shows rows; firstRows is the bar.
    await settle(chrome, SETTLE_MS);
    await chrome.navigate('about:blank');
    await chrome.waitFor("location.href === 'about:blank' && document.readyState === 'complete'");

    // The measured first load: a cold browser cache against the warm server, every request counted.
    const target = await chrome.send('Target.getTargetInfo', {});
    network = await openNetworkCapture(chrome.profileDirectory, itemsLink.origin, target?.targetInfo?.targetId);
    await chrome.send('Network.setCacheDisabled', { cacheDisabled: true });
    await chrome.navigate(itemsLink.href);
    await chrome.waitFor(rowsShown, LOAD_TIMEOUT_MS); // budget: 60-second hang ceiling for a board that never shows rows; firstRows is the bar.
    const settled = await settle(chrome, SETTLE_MS);
    const load = await chrome.stable('({ firstRowsMs: window.__pbBudgets.firstRowsMs, endMs: performance.now(), timeOrigin: performance.timeOrigin, items: data?.project?.items?.length ?? null })');
    const traffic = network.snapshot('firstLoad', 0, load.endMs, load.timeOrigin);
    await chrome.send('Network.setCacheDisabled', { cacheDisabled: false });

    // Every tab once from the Items address, then two item rows.
    const clicks = [], tabs = [];
    for (const [tab, selector] of TAB_TARGETS) {
      const sample = await measuredPress(chrome, `document.querySelector('.tab[data-tab="${tab}"]')`, { kind: 'tab', tab, target: selector });
      clicks.push({ name: `tab:${tab}`, ms: sample.feedbackMs });
      tabs.push({ name: `tab:${tab}`, ms: sample.drawMs });
    }
    const rowIds = await chrome.stable("[...document.querySelectorAll('#chain .row[data-item]')].slice(0, 6).map((row) => Number(row.dataset.item))");
    for (const item of [rowIds[0], rowIds.at(-1)].filter((id, index, all) => Number.isSafeInteger(id) && all.indexOf(id) === index)) {
      const sample = await measuredPress(chrome, `document.querySelector('#chain .row[data-item="${item}"]')`, { kind: 'item', item });
      clicks.push({ name: `item:${item}`, ms: sample.feedbackMs });
    }

    /** The slowest sample; one that never painted is the slowest of all. */
    const worst = (samples) => samples.find((sample) => !Number.isFinite(sample.ms))
      ?? samples.reduce((slow, sample) => (slow === null || sample.ms > slow.ms ? sample : slow), null);
    const slowClick = worst(clicks), slowTab = worst(tabs);
    const largest = [...traffic.requests].sort((left, right) => (right.responseBytes ?? 0) - (left.responseBytes ?? 0)).slice(0, 5)
      .map((request) => ({ path: request.path, bytes: request.responseBytes, complete: request.complete }));
    return {
      population: { items: load.items },
      clickFeedback: { worst: slowClick?.ms ?? null, sample: slowClick?.name ?? 'no click measured', samples: clicks },
      tabSwitch: { worst: slowTab?.ms ?? null, sample: slowTab?.name ?? 'no tab measured', samples: tabs },
      firstRows: { value: load.firstRowsMs },
      firstLoadBytes: { value: traffic.requestBytes, requests: traffic.requests.length, settled, largest },
    };
  } finally {
    try { network?.close(); }
    finally {
      if (chrome) await chrome.close();
    }
  }
}

/** Measure a running view from the command line; exit 1 when a budget is missed. */
async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { url: { type: 'string' } } });
  if (!values.url) {
    process.stdout.write("Usage: node apps/cli/tests/fixtures/cockpit/perf/budgets.mjs --url '<view link with its key>'\n");
    return 2;
  }
  const report = await measureBudgets(new URL(values.url));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n${budgetSummary(report)}\n`);
  return budgetFailures(report).length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
