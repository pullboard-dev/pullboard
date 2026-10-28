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
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const pane = document.querySelector('[data-pane="' + sample.tab + '"]'), box = pane?.getBoundingClientRect();
        if (view.tab === sample.tab && pane && !pane.hidden && box.width > 0 && box.height > 0) sample.end = performance.now();
      }));
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
        await chrome.waitFor(`window.__tabSpeed.actions.at(-1)?.tab === '${tab}' && Number.isFinite(window.__tabSpeed.actions.at(-1)?.end)`);
      }
    }
    return await chrome.stable(`({ ...window.__tabSpeed, next: undefined,
      items: data.project.items.length, agents: data.project.agents.length,
      visibleTab: view.tab, browser: navigator.userAgent })`);
  } finally {
    if (chrome) await chrome.close();
    if (server) await stopView(server);
  }
}
