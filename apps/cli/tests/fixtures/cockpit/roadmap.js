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
