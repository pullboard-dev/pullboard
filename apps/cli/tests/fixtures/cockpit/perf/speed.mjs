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
import {
  generateStressBoard,
  removeStressBoard,
} from './generate.mjs';
import {
  startView,
  stopView,
} from './run.mjs';

/** Every tab the speed contract measures, in strip order; files split them to stay inside the 120 s file budget. */
export const ALL_TABS = ['spec', 'doctrine', 'items', 'roadmap', 'dashboard'];

/** The strip menu each page lives in; Work's pages are plain tabs. */
const MENU_OF = { spec: 'rules', doctrine: 'rules', dashboard: 'insights' };

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
export async function measureTabSpeed(board, tabs = ALL_TABS) {
  const executable = findChromeExecutable();
  if (!executable) throw new Error('Chrome is required for the tab speed contract');
  const profile = join(board.workspace, 'tab-speed-chrome');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  let server, chrome;
  try {
    server = await startView(board);
    chrome = await stableChrome(await startChrome({ url: 'about:blank', executable, profileDirectory: profile,
      env: { HOME: profile, PATH: process.env.PATH ?? '/usr/bin:/bin' } }));
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: observationScript() });
    await chrome.navigate(server.link.href);
    await chrome.waitFor("!!data?.project && !document.body.classList.contains('loading')");
    await chrome.stable(inputScript(), "document.querySelector('[data-tab=items]')");
    for (const mode of [{ repeat: false }, { repeat: true }, { isolation: true }]) {
      for (const tab of tabs) {
        // Rules and Insights pages sit in a menu; open it first, outside the measured click [N26].
        if (MENU_OF[tab]) await press(chrome, `document.querySelector('[data-nav-group="${MENU_OF[tab]}"]')`);
        await chrome.stable(`window.__tabSpeed.next = ${JSON.stringify(mode)}`, `document.querySelector('[data-tab="${tab}"]')`);
        await press(chrome, `document.querySelector('[data-tab="${tab}"]')`);
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
      }
    }
    return await chrome.stable(`({ ...window.__tabSpeed, next: undefined, current: undefined,
      items: data.project.items.length, agents: data.project.agents.length,
      visibleTab: view.tab, browser: navigator.userAgent })`);
  } finally {
    try { if (chrome) await chrome.close(); }
    finally { if (server) await stopView(server); }
  }
}

/** One split file's whole contract: generate the real large board, click each of `tabs` first, again and isolated, and hold the 100 ms bar [N26]. */
export async function checkTabSpeed(t, tabs) {
  const board = generateStressBoard({ seed: 'tab-speed-1600', size: 1600, agents: 1150, shouts: 40000 });
  try {
    assert.equal(board.agentCount, 1150);
    assert.equal(board.shoutCount, 40000);
    const report = await measureTabSpeed(board, tabs);
    t.diagnostic(JSON.stringify({ population: { items: board.size, agents: board.agentCount, shouts: board.shoutCount }, ...report }));
    assert.equal(report.items, 1600);
    assert.equal(report.actions.length, tabs.length * 2);
    assert.ok(report.parse.length > 0, 'actual state body bytes and JSON parse time are observed');
    assert.ok(report.fetch.length > 0, 'actual browser fetch time is observed');
    assert.ok(report.render.length >= tabs.length * 2, 'every click retains its real render duration');
    assert.equal(report.isolation.length, tabs.length);
    for (const sample of report.isolation) {
      assert.deepEqual(sample.hiddenMutations, [], `${sample.tab} does not rebuild another tab's data`);
      assert.equal(sample.ready, true, `${sample.tab} isolation control reaches its real content`);
    }
    for (const sample of report.actions) {
      assert.equal(sample.ready, true, `${sample.tab} paints its actual content after the click`);
      assert.ok(Number.isFinite(sample.end), `${sample.tab} has a real painted timestamp`);
      assert.ok(sample.end - sample.start < 100,
        `${sample.tab} ${sample.repeat ? 'repeat' : 'first'} click painted in ${sample.end - sample.start} ms (bar <100 ms)`);
    }
  } finally { removeStressBoard(board); }
}
