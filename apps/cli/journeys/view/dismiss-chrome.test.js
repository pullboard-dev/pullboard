// pullboard: browser
/** @pullboard-test-gui */
/** The result panel stays where a settled decision left the page, past the old six-second window, in real Chrome [H12,#9529,#9865]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fileFixtureItem } from '../../../../packages/gate/tests/fixtures/testkit.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

test('clause 1: scroll, page height and the result panel box are unchanged across the old 6 s window after a decision settles [H12,#9529,#9865]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to measure the result panel.');
  const box = machine();
  const demo = project(box, 'dismiss-stable', '# Dismiss stability\n\n## G · Goals\n- G1 [approved, must] First goal. | gate: review\n');
  const run = (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }); // The cockpit machine returns the output and throws on a refusal.
  fileFixtureItem(box, demo.repo, { run, lane: 'web', title: 'First item', criterion: 'It exists.', args: ['--specs', 'G1'] });
  fileFixtureItem(box, demo.repo, { run, lane: 'web', title: 'Second item', criterion: 'It exists too.', args: ['--specs', 'G1'] });
  const view = await startView(box);
  const profile = privateFixtureFiles('pullboard-dismiss-chrome-').root;
  let chrome;
  /** Scroll, page height and the result panel's box, read in one step. */
  const measure = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const r = document.querySelector('#console').getBoundingClientRect();
    return { y: scrollY, height: document.documentElement.scrollHeight, hidden: document.querySelector('#console').hidden, box: [r.x, r.y + scrollY, r.width, r.height] };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 700, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    // A real decision through the page's own move path: it fills the result panel.
    await chrome.stable("act('shout', { to: 'coordinator', text: 'settle probe' }, null).then(() => { window.__settled = true; });true");
    await chrome.waitFor("window.__settled === true && !document.querySelector('#console').hidden && document.querySelector('#console').className.includes('ok')");
    const settled = await measure();
    await chrome.stable('window.__waited = false; setTimeout(() => { window.__waited = true; }, 7000); true'); // the old six-second timer, plus a second of slack
    await chrome.waitFor('window.__waited === true', 15_000); // budget: hang ceiling for the page-side seven-second wait; no speed threshold.
    assert.deepEqual(await measure(), settled, 'nothing scrolls, reflows or hides after the old timer would have fired');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); rmSync(profile, { recursive: true, force: true }); await view.stop(); }
});
