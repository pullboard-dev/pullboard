/** Measure real input-to-painted tab changes with the #606 Chrome input boundary [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  findChromeExecutable,
  startChrome,
} from '../../chrome.js';
import {
  press,
  stableChrome,
} from '../stable.js';
import { removeStressBoard } from './generate.mjs';
import { statusCounts } from './generate.mjs';
import { awaitStressBoard } from './stress-cache.mjs';
import {
  TAB_SPEED_GOAL_MS,
  TAB_SPEED_ROWS,
} from './tab-speed-rows.mjs';
import {
  startView,
  stopView,
} from './run.mjs';

/** Every tab the speed contract measures, in strip order; files split them to stay inside the 120 s file budget. */
export const ALL_TABS = ['spec', 'doctrine', 'items', 'roadmap', 'dashboard'];

/** Setup wait for the large state's first load; not part of any measured click. */
function firstLoadMs() { return 60_000; }
const LOADED = "!!data?.project && !document.body.classList.contains('loading')";

/** The strip menu each page lives in; Work's pages are plain tabs. */
const MENU_OF = { spec: 'rules', doctrine: 'rules', dashboard: 'insights' };

/**
 * Time stages for diagnosis: with PULLBOARD_TAB_SPEED_TRACE set, each stage prints one line with its elapsed milliseconds;
 * unset, a stage just runs. Off by default so a normal run prints nothing extra, and the line prints even when the stage throws,
 * because a stage that hung then failed is the one worth naming [C7].
 */
export function tabSpeedTrace(env = process.env, write = line => process.stderr.write(`${line}\n`)) {
  const on = Boolean(env.PULLBOARD_TAB_SPEED_TRACE) && env.PULLBOARD_TAB_SPEED_TRACE !== '0';
  return async function stage(label, run) {
    inFlight.push(label);
    const start = performance.now();
    try { return await run(); }
    finally {
      inFlight.pop();
      if (on) write(`tab-speed-trace: ${label} ${Math.round(performance.now() - start)} ms`);
    }
  };
}

/** Stages begun and not yet ended, outermost first; lets a watchdog name the stage a run sits in. */
const inFlight = [];
export function tabSpeedStageNow() { return inFlight.join(' > ') || 'none'; }

/** Longest any one setup stage may wait before the run fails naming it; board generation and first load keep their own larger setup budgets. */
const STAGE_MS = 30_000;
const FIRST_LOAD_GRACE_MS = 5000;

/** Run a stage, failing with its name if it has not finished within `ms` instead of waiting for the file kill. */
export function boundedStage(stage, label, ms, run) {
  let timer;
  const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`tab-speed stage "${label}" did not finish within ${ms / 1000} s`)), ms); });
  return Promise.race([stage(label, run), stuck]).finally(() => clearTimeout(timer));
}

/** Fail with the stage name if `work` has not finished in `ms`, instead of waiting for the file kill. */
export function nameStuckStage(work, ms) {
  let timer;
  const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`STUCK in stage: ${tabSpeedStageNow()}`)), ms); });
  return Promise.race([work, stuck]).finally(() => clearTimeout(timer));
}

/** Observe actual fetch/body/parse work before the page starts, without replacing its data. */
function observationScript() {
  return `(() => {
    const evidence = window.__tabSpeed = { fetch: [], parse: [], render: [], actions: [], isolation: [], tasks: [] };
    try {
      const observer = new PerformanceObserver(list => evidence.tasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, durationMs: entry.duration }))));
      observer.observe({ type: 'longtask', buffered: true }); evidence.longTasksAvailable = true;
    } catch { evidence.longTasksAvailable = false; }
    const fetchOriginal = window.fetch;
    window.fetch = async function (...args) {
      const start = performance.now();
      try { return await fetchOriginal.apply(this, args); }
      finally { evidence.fetch.push({ durationMs: performance.now() - start }); }
    };
    const jsonOriginal = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      if (!this.url.includes('/state')) return jsonOriginal.apply(this, args);
      const start = performance.now(), text = await this.text(), bodyMs = performance.now() - start;
      const parseStart = performance.now(), value = JSON.parse(text);
      evidence.parse.push({ bodyMs, parseMs: performance.now() - parseStart, bytes: new TextEncoder().encode(text).length });
      return value;
    };
  })()`;
}

/** Instrument actual rendering and the first painted target after each genuine pointer event. */
function inputScript() {
  return `(() => {
    const evidence = window.__tabSpeed, original = render;
    render = function (...args) {
      const start = performance.now(), tab = view.tab;
      try { return original.apply(this, args); }
      finally { evidence.render.push({ tab, start, end: performance.now(), durationMs: performance.now() - start }); }
    };
    addEventListener('click', event => { const sample = evidence.current; if (sample && event.target.closest('[data-tab]')?.dataset.tab === sample.tab) sample.clickAt = performance.now(); }, true);
    addEventListener('mousedown', event => {
      const button = event.target.closest('[data-tab]');
      if (!button || !evidence.next) return;
      const sample = { ...evidence.next, tab: button.dataset.tab, start: performance.now(), end: null };
      evidence.next = null;
      evidence.current = sample;
      (sample.isolation ? evidence.isolation : evidence.actions).push(sample);
      const pane = document.querySelector('[data-pane="' + sample.tab + '"]');
      let revision = 0, previous = null;
      sample.hiddenMutations = [];
      const paneObservers = !sample.isolation ? [] : Object.entries({ spec: '#spec-list', doctrine: '#doctrine-list', items: '#chain',
        roadmap: '#roadmap', dashboard: '#dashboard', shouts: '#feed', activity: '#activity' }).map(([tab, selector]) => {
        const watched = document.querySelector(selector);
        const monitor = new MutationObserver(() => {
          if (tab !== sample.tab && !sample.hiddenMutations.includes(tab)) sample.hiddenMutations.push(tab);
        });
        if (watched) monitor.observe(watched, { childList: true, subtree: true, characterData: true });
        return monitor;
      });
      /** Stop only the observers created for this input after its measurement settles. */
      const finish = () => { observer.disconnect(); for (const monitor of paneObservers) monitor.disconnect(); };
      const observer = new MutationObserver(() => { revision++; });
      if (pane) observer.observe(pane, { childList: true, subtree: true, characterData: true });
      const timeout = setTimeout(() => { sample.ready = false; finish(); }, 60000);
      /** End after the actual target is visible and unchanged across two painted frames. */
      function frame() {
        if (sample.ready === false) return;
        const box = pane?.getBoundingClientRect();
        const targets = { spec: '#spec-list .row', doctrine: '#doctrine-list .row', items: '#chain .row',
          roadmap: '#roadmap .milestone-head', dashboard: '#dashboard .dash-live .dash-stage' };
        const content = pane?.querySelector(targets[sample.tab]);
        const ready = Boolean(view.tab === sample.tab && pane && !pane.hidden && content && box.width > 0 && box.height > 0);
        const key = ready ? [revision, box.x, box.y, box.width, box.height, content.getBoundingClientRect().x, content.getBoundingClientRect().y].join(':') : null;
        if (key && key === previous) {
          sample.ready = true; sample.end = performance.now(); finish(); clearTimeout(timeout); return;
        }
        previous = key;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, true);
  })()`;
}

/** Measure first and repeated switches of `tabs` on one real generated board; always drain owned Chrome and server. */
export async function measureTabSpeed(board, tabs = ALL_TABS, deps = {}) {
  const { findChromeExecutable: findChrome = findChromeExecutable, startChrome: launch = startChrome, stableChrome: stabilise = stableChrome,
    press: pressTarget = press, startView: start = startView, stopView: stop = stopView, stage = tabSpeedTrace(), stageMs = STAGE_MS, firstLoadLimit = firstLoadMs() } = deps;
  const executable = findChrome();
  if (!executable) throw new Error('Chrome is required for the tab speed contract');
  const profile = join(board.workspace, 'tab-speed-chrome');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  let server, chrome;
  try {
    server = await boundedStage(stage, 'server start', stageMs, () => start(board));
    chrome = await boundedStage(stage, 'chrome start', stageMs, async () => stabilise(await launch({ url: 'about:blank', executable, profileDirectory: profile,
      env: { HOME: profile, PATH: process.env.PATH ?? '/usr/bin:/bin' } })));
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: observationScript() });
    // First load of the 40000-shout state is setup, not a measured click: give a loaded runner a minute [N26].
    await boundedStage(stage, 'first load', firstLoadLimit + FIRST_LOAD_GRACE_MS, async () => {
      await chrome.navigate(server.link.href);
      await chrome.waitFor(LOADED, firstLoadLimit);
    });
    await chrome.stable(inputScript(), "document.querySelector('[data-tab=items]')");
    const hangs = [], hung = new Set();
    for (const mode of [{ repeat: false }, { repeat: true }, { isolation: true }]) {
      for (const tab of tabs) {
        if (hung.has(tab)) continue; // a tab that hung once is not measured again; its hang is the record
        try {
          await stage(`${mode.repeat ? 'repeat' : mode.isolation ? 'isolation' : 'first'} click ${tab}`, async () => {
            // Rules and Insights pages sit in a menu; open it first, outside the measured click [N26].
            if (MENU_OF[tab]) await pressTarget(chrome, `document.querySelector('[data-nav-group="${MENU_OF[tab]}"]')`);
            await chrome.stable(`window.__tabSpeed.next = ${JSON.stringify(mode)}`, `document.querySelector('[data-tab="${tab}"]')`);
            await pressTarget(chrome, `document.querySelector('[data-tab="${tab}"]')`);
            // Observe the unchanged 100 ms bar without any CDP/layout sampling inside that window.
            await new Promise(resolve => setTimeout(resolve, 100));
            await chrome.stable(`(async () => {
              const deadline = performance.now() + 60000;
              while (performance.now() < deadline) {
                const sample = window.__tabSpeed.current;
                if (sample?.tab === '${tab}' && typeof sample.ready === 'boolean') return;
                await new Promise(requestAnimationFrame);
              }
              throw new Error('the native tab measurement did not settle');
            })()`, `document.querySelector('[data-tab="${tab}"]')`);
          });
        } catch (error) {
          // A page that never answers is recorded as a hang, not thrown, so the audit row can name it [N26].
          if (error?.code !== 'CDP_TIMEOUT') throw error;
          hung.add(tab);
          hangs.push({ tab, mode: mode.repeat ? 'repeat' : mode.isolation ? 'isolation' : 'first', message: error.message });
        }
      }
    }
    const report = await chrome.stable(`({ ...window.__tabSpeed, next: undefined, current: undefined,
      items: data.project.items.length, agents: data.project.agents.length,
      visibleTab: view.tab, browser: navigator.userAgent })`);
    return { ...report, hangs };
  } finally {
    try { if (chrome) await chrome.close(); }
    finally { if (server) await stop(server); }
  }
}

/** One split file's whole contract: generate the real large board, click each of `tabs` first, again and isolated, and hold the 100 ms bar [N26]. */
export async function checkTabSpeed(t, tabs) {
  const stage = tabSpeedTrace();
  const board = await stage('board generation', () => awaitStressBoard({ seed: 'tab-speed-1600', size: 1600, agents: 1150, shouts: 40000 }));
  try {
    assert.equal(board.agentCount, 1150);
    assert.equal(board.shoutCount, 40000);
    const report = await measureTabSpeed(board, tabs, { stage });
    t.diagnostic(JSON.stringify({ population: { items: board.size, agents: board.agentCount, shouts: board.shoutCount }, ...report }));
    // The first load is open-first since de3affd4f4 (#6697): withdrawn items arrive only when a screen that shows them asks.
    // The roadmap and dashboard also ask for finished work since 2da4b43e24, so a run that clicks either holds every item [C7].
    const asksFinished = tabs.includes('roadmap') || tabs.includes('dashboard');
    assert.equal(report.items, asksFinished ? board.size : board.size - statusCounts(board.size).withdrawn);
    // A tab that hung is recorded once in `hangs` and measured no further; every other tab keeps all its clicks.
    const hungTabs = new Set(report.hangs.map(hang => hang.tab)), live = tabs.filter(tab => !hungTabs.has(tab));
    assert.equal(report.actions.filter(sample => !hungTabs.has(sample.tab)).length, live.length * 2, 'every other tab is clicked first and again');
    assert.ok(report.parse.length > 0, 'actual state body bytes and JSON parse time are observed');
    assert.ok(report.fetch.length > 0, 'actual browser fetch time is observed');
    assert.ok(report.render.length >= live.length * 2, 'every click retains its real render duration');
    assert.equal(report.isolation.filter(sample => !hungTabs.has(sample.tab)).length, live.length, 'every other tab has its isolation control');
    for (const sample of report.isolation) {
      if (hungTabs.has(sample.tab)) continue;
      assert.deepEqual(sample.hiddenMutations, [], `${sample.tab} does not rebuild another tab's data`);
      assert.equal(sample.ready, true, `${sample.tab} isolation control reaches its real content`);
    }
    // Goal: 100 ms. A tab's row in tab-speed-rows.mjs is an audited exception at its measured worst paint; the bar itself never moves.
    const goalMs = TAB_SPEED_GOAL_MS, rows = TAB_SPEED_ROWS;
    for (const hang of report.hangs) {
      assert.ok(rows[hang.tab]?.hang === true, `${hang.tab} ${hang.mode} never answered the browser: ${hang.message} (goal ${goalMs} ms; record it in tab-speed-rows.mjs only as an audited exception)`);
    }
    for (const sample of report.actions) {
      if (hungTabs.has(sample.tab)) continue;
      assert.equal(sample.ready, true, `${sample.tab} paints its actual content after the click`);
      assert.ok(Number.isFinite(sample.end), `${sample.tab} has a real painted timestamp`);
      const kind = sample.repeat ? 'repeat' : 'first', limit = rows[sample.tab]?.[kind] ?? goalMs, took = sample.end - sample.start;
      assert.ok(took < limit, `${sample.tab} ${kind} click painted in ${took} ms (bar <${limit} ms, goal <${goalMs} ms)`);
      if (took < goalMs && limit > goalMs) t.diagnostic(`${sample.tab} ${kind} click meets the ${goalMs} ms goal; remove its row in tab-speed-rows.mjs`);
    }
  } finally { removeStressBoard(board); }
}
