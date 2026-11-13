/** Roadmap cockpit journey helpers: a named-wait Chrome and fixture landing, shared by the journeys/roadmap/cockpit files [N26]. */
import {
  openSnapshotChrome,
  press,
  roadmapRow,
} from './harness.js';

/** The roadmap state a failed wait saw: its tab, rows, row ids and expansion, dots and open detail (#938). */
const ROADMAP_FACTS = `JSON.stringify({ tab: typeof view === 'undefined' ? null : view.tab,
  rows: document.querySelectorAll('#roadmap .milestone-item').length,
  ids: [...document.querySelectorAll('#roadmap .milestone-item .id')].slice(0, 12).map((node) => node.textContent),
  expanded: [...document.querySelectorAll('#roadmap .milestone-item')].slice(0, 12).map((row) => row.getAttribute('aria-expanded')),
  dots: document.querySelectorAll('#roadmap .dot').length,
  detail: (document.querySelector('#detail h2')?.textContent || '').trim().slice(0, 80),
  pressed: window.__pressed ?? null, jump: window.__roadmapJump ?? null })`;

/**
 * Name the step a roadmap wait was waiting on and the roadmap state it last saw, so a timeout reads as a diagnosis
 * rather than a bare 90 s test timeout (#938).
 */
function namedRoadmapWaits(chrome) {
  const waitFor = chrome.waitFor.bind(chrome);
  chrome.waitFor = async (...args) => {
    try { return await waitFor(...args); }
    catch (error) {
      try { error.message += `; waiting for step: ${args[0]}; the roadmap showed ${await chrome.stable(ROADMAP_FACTS)}`; } catch { /* the page may be gone; the wait's own error stays */ }
      throw error;
    }
  };
  return chrome;
}

/** Open the Chrome a roadmap case drives, with its waits named (#938). */
export async function openRoadmapChrome(...args) {
  return namedRoadmapWaits(await openSnapshotChrome(...args));
}

/** Expand a real roadmap row, then use its explicit link to leave for Items. */
export async function openRoadmapItem(chrome, id) {
  const row = roadmapRow(id);
  if (await chrome.stable(row + ".getAttribute('aria-expanded')") !== 'true') await press(chrome, row);
  await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
  await press(chrome, row + ".parentElement.querySelector('.milestone-why a[data-go]')");
}

/** Record a real trunk merge before reporting a fixture item as landed. */
export function landRoadmapItem(box, p, id) {
  box.git(p.repo, 'merge', '--no-ff', '--no-edit', p.itemBranches.get(`${p.baseBranch}:${id}`));
  const commit = box.git(p.repo, 'rev-parse', 'HEAD');
  box.run(p.repo, 'merged', String(id), commit);
  return commit;
}

/** Record target identity, geometry and native events without changing the Roadmap's input path. */
export async function watchRoadmapPress(chrome, key) {
  await chrome.stable(`(() => {
    const selector = '#roadmap-panel [data-roadmap-jump=' + CSS.escape(${JSON.stringify(key)}) + ']';
    let original = document.querySelector(selector);
    const originalRender = window.render;
    const nodeIds = new WeakMap(); let nextNodeId = 0;
    const nodeId = node => { if (!node) return null; if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId); return nodeIds.get(node); };
    const trace = window.__roadmapPress = { original, originalRender, samples:[], events:[] };
    /** Keep bounded observations of the live target and its original node. */
    const record = phase => {
      const current = document.querySelector(selector), box = current?.getBoundingClientRect();
      const panel = document.querySelector('#roadmap-panel'), list = document.querySelector('#roadmap-list');
      trace.samples.push({ phase, at:performance.now(), connected:original.isConnected, same:current === original,
        box:box ? [box.x,box.y,box.width,box.height] : null, scroll:[scrollX,scrollY],
        panelId:nodeId(panel), panelCount:panel?.querySelectorAll('[data-roadmap-jump]').length,
        listId:nodeId(list), listCount:list?.querySelectorAll(':scope > [data-key]').length,
        panelScroll:panel?.scrollTop, count:current?.querySelector('b')?.textContent, deferred:deferredClickRender });
      if (trace.samples.length > 8) trace.samples.shift();
    };
    trace.record = record;
    window.render = function(...args) { record('before render'); const result = originalRender.apply(this,args); record('after render'); return result; };
    trace.listeners = ['pointermove','pointerdown','pointerup','click'].map(type => {
      const listener = event => {
        const button = event.target.closest?.('[data-roadmap-jump]');
        if (type === 'pointerdown' && button?.dataset.roadmapJump === ${JSON.stringify(key)}) { original = button; trace.original = button; }
        record(type); trace.events.push({ type, key:button?.dataset.roadmapJump || null });
        if(trace.events.length > 8) trace.events.shift();
      };
      document.addEventListener(type, listener, true); return [type,listener];
    });
    record('watch');
  })()`);
  return {
    /** Read only bounded samples and event keys, never retain DOM objects in the host. */
    async snapshot() {
      return JSON.parse(await chrome.stable(`JSON.stringify((() => { const t=window.__roadmapPress; t.record('snapshot'); return {samples:t.samples,events:t.events}; })())`));
    },
    /** Restore the actual renderer and remove only this observer's event listeners. */
    async dispose() {
      await chrome.stable(`(() => { const t=window.__roadmapPress; if(!t)return; window.render=t.originalRender; for(const [type,listener] of t.listeners)document.removeEventListener(type,listener,true); delete window.__roadmapPress; })()`);
    },
  };
}
