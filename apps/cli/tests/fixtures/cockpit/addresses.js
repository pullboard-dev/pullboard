/** Shared helpers for the address journeys: real clicks and the browser's own history [N38,N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPEC,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  settled,
} from './harness.js';

export const SCRIPT = "typeof view === 'object' && typeof data === 'object' && !!data?.project && data.root === view.root && !document.body.classList.contains('loading')";
/** Read the actual rendered place without waiting for the expected answer. */
export async function observed(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify({ address:location.pathname + location.hash, root:view.root, tab:document.querySelector('.tab.on')?.dataset.tab, panes:[...document.querySelectorAll('[data-pane]')].filter(node => !node.hidden).map(node => node.dataset.pane) })`));
}
/** Check the address, repo and visible pane independently of internal selection state. */
export async function assertPlace(chrome, address, pane, root) {
  assert.deepEqual(await observed(chrome), { address, root, tab: pane, panes: [pane] });
}
/** Navigate from a blank page and wait for the new document's script before reading its board. */
export async function openAddress(chrome, server, address) {
  await chrome.send('Page.navigate', { url: 'about:blank' });
  await settled(chrome, "location.href === 'about:blank'");
  const target = new URL(address, server.link);
  target.search = server.link.search;
  await chrome.send('Page.navigate', { url: target.href });
  await settled(chrome, SCRIPT);
  // An item address opens its item; the view reads its detail then, and its heading arrives with it.
  if (/\/items\/\d+$/.test(target.pathname)) await settled(chrome, "!!document.querySelector('#detail h2, #detail .empty')");
}
/** Assert the detail itself, so suppressing row rendering produces an assertion failure. */
export async function assertHeading(chrome, selector, id, text) {
  const heading = await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' .item-panel-head, ' + selector + ' h2')})?.textContent ?? null`);
  assert.ok(heading?.includes(id) && heading.includes(text), `detail heading names ${id} ${text}: ${heading}`);
}
/** Read the real browser stack, including same-document pushState entries. */
export async function history(chrome) {
  const { currentIndex, entries } = await chrome.send('Page.getNavigationHistory');
  return { currentIndex, length: entries.length };
}
/** Click once, await the normal rendering boundary, then assert exactly one new place entry. */
export async function onePlace(chrome, selector, address, pane, root) {
  const before = await history(chrome);
  await press(chrome, selector);
  await settled(chrome, SCRIPT);
  await assertPlace(chrome, address, pane, root);
  const after = await history(chrome);
  assert.deepEqual(after, { currentIndex: before.currentIndex + 1, length: before.length + 1 }, `${address}: one entry per change`);
  return { address, pane, root };
}
/** Create distinct real rows without duplicate identifiers, and two real items. */
export function addressBoard(box, name, group) {
  const spec = SPEC.replace(/^- G2 .*$/m, `- G2 [pending, must] ${name} distinct specification row. | gate: review`);
  const p = project(box, name, spec, { practice: 'DOCTRINE.md', ...(group ? { project: group } : {}) });
  writeFileSync(join(p.repo, 'DOCTRINE.md'), `# Local rules\n\n## Team\n- PB1 [approved, must] ${name} distinct practice rule. | gate: review\n`);
  box.run(p.repo, 'add', 'web', `${name} first address item`, '--specs', 'G1');
  box.run(p.repo, 'add', 'web', `${name} second address item`, '--specs', 'G1');
  box.run(p.repo, 'milestone', 'add', `${name} address milestone`, '--reason', 'Arrange fixture release', '--items', '1,2');
  return p;
}
/**
 * The in-process twin of addressBoard: the same board, with its CLI calls awaited in this process instead of launched.
 * Why: each launch cost seconds on a loaded runner, and the journeys that use it sit near their file budget.
 */
export async function addressBoardLocal(box, name, group) {
  const spec = SPEC.replace(/^- G2 .*$/m, `- G2 [pending, must] ${name} distinct specification row. | gate: review`);
  const p = project(box, name, spec, { practice: 'DOCTRINE.md', ...(group ? { project: group } : {}) });
  writeFileSync(join(p.repo, 'DOCTRINE.md'), `# Local rules\n\n## Team\n- PB1 [approved, must] ${name} distinct practice rule. | gate: review\n`);
  await box.inProcess(p.repo, 'add', 'web', `${name} first address item`, '--specs', 'G1');
  await box.inProcess(p.repo, 'add', 'web', `${name} second address item`, '--specs', 'G1');
  await box.inProcess(p.repo, 'milestone', 'add', `${name} address milestone`, '--reason', 'Arrange fixture release', '--items', '1,2');
  return p;
}
/** Own one browser and server, with cleanup even if an assertion fails. */
export async function withBrowser(box, run) {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for address checks');
  const server = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-addresses-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await settled(chrome, SCRIPT);
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the tabs under test render.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await run(chrome, server);
    assert.deepEqual(chrome.exceptions, [], 'new-document navigation causes no page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Wait only for the addressed lookup to finish, then inspect the real target and its viewport box. */
export async function assertShout(chrome, id, text) {
  await settled(chrome, `${SCRIPT} && !document.querySelector('#shout-address-status')?.textContent.startsWith('Loading')`);
  const result = JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const node=document.getElementById('shout-${id}'), rect=node?.getBoundingClientRect();
    return { text:node?.querySelector('.sx-tx')?.textContent ?? null, heading:node?.querySelector('h2')?.textContent ?? null, marked:node?.classList.contains('found') ?? false, top:rect?.top, bottom:rect?.bottom, bar:document.querySelector('.top').getBoundingClientRect().bottom, height:innerHeight };
  })())`));
  assert.equal(result.text, text, 'the addressed shout body is rendered');
  assert.equal(result.heading, `Shout #${id}`, 'the addressed shout has its own heading');
  assert.equal(result.marked, true, 'the addressed shout stays marked');
  assert.ok(result.top >= result.bar && result.bottom <= result.height, `the shout is visible below the tab bar: ${JSON.stringify(result)}`);
}
