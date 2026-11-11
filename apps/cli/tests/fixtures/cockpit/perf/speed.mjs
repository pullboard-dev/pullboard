/** Measure real input-to-painted tab changes with the #606 Chrome input boundary [N26]. */
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
  startView,
  stopView,
} from './run.mjs';

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
          roadmap: '#roadmap .milestone-head', dashboard: '#dashboard .dash-hero' };
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

/** Measure first and repeated switches on one real generated board; always drain owned Chrome and server. */
export async function measureTabSpeed(board) {
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
    await chrome.stable(inputScript(), "document.querySelector('[data-tab=spec]')");
    for (const mode of [{ repeat: false }, { repeat: true }, { isolation: true }]) {
      for (const tab of ['spec', 'doctrine', 'items', 'roadmap', 'dashboard']) {
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
