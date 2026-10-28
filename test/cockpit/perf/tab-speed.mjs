/** Measure real input-to-painted tab changes with the #606 Chrome input boundary [N26]. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findChromeExecutable, startChrome } from '../../chrome-fixture.js';
import { press, stableChrome } from '../stable.js';
import { startView, stopView } from './run.mjs';

/** Observe actual fetch/body/parse work before the page starts, without replacing its data. */
function observationScript() {
  return `(() => {
    const evidence = window.__tabSpeed = { fetch: [], parse: [], render: [], actions: [] };
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
      finally { evidence.render.push({ tab, durationMs: performance.now() - start }); }
    };
    addEventListener('mousedown', event => {
      const button = event.target.closest('[data-tab]');
      if (!button || !evidence.next) return;
      const sample = { ...evidence.next, tab: button.dataset.tab, start: performance.now(), end: null };
      evidence.next = null;
      evidence.actions.push(sample);
      const pane = document.querySelector('[data-pane="' + sample.tab + '"]');
      let revision = 0, previous = null;
      sample.hiddenMutations = [];
      const paneObservers = Object.entries({ spec: '#spec-list', doctrine: '#doctrine-list', items: '#chain',
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
        const key = ready ? [revision, box.width, box.height].join(':') : null;
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
    await chrome.stable(inputScript());
    for (const repeat of [false, true]) {
      for (const tab of ['spec', 'doctrine', 'items', 'roadmap', 'dashboard']) {
        await chrome.stable(`window.__tabSpeed.next = { repeat: ${repeat} }`);
        await press(chrome, `document.querySelector('[data-tab="${tab}"]')`);
        await chrome.waitFor(`window.__tabSpeed.actions.at(-1)?.tab === '${tab}' && typeof window.__tabSpeed.actions.at(-1)?.ready === 'boolean'`);
      }
    }
    return await chrome.stable(`({ ...window.__tabSpeed, next: undefined,
      items: data.project.items.length, agents: data.project.agents.length,
      visibleTab: view.tab, browser: navigator.userAgent })`);
  } finally {
    try { if (chrome) await chrome.close(); }
    finally { if (server) await stopView(server); }
  }
}
