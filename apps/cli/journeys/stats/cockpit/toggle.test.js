// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit stats checks: toggle [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tapTarget } from '../../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { press } from '../../../tests/fixtures/cockpit/harness.js';
import { tapTouch } from '../../../tests/fixtures/cockpit/harness.js';
import { statsToggleState } from './fixture.js';
import { saveStatsToggleShot } from './fixture.js';

/** Exercise every real input path that opens and folds the proof card, then check its responsive targets. */
// One colour scheme per test keeps each real Chrome flow inside its hang ceiling: the file's cases run apart, not shorter.
for (const scheme of ['light', 'dark']) test(`the stats card folds from its summary line in ${scheme} [N26]`, {
  timeout: 30_000, // budget: stop a hung local Chrome flow, not a rendering-speed assertion.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the stats summary toggle criterion.');

  const box = machine();
  const alpha = project(box, 'stats-summary-toggle');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stats-summary-toggle-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats-summary')");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("view.tab === 'items'");
    await chrome.stable(`(() => {
      window.__statsTouchTargets = [];
      document.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch') window.__statsTouchTargets.push(event.target.closest('#proof-stats-summary') !== null);
      }, true);
      return true;
    })()`);

    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      const start = await statsToggleState(chrome);
      assert.equal(start.expanded, 'false', `${width}px ${scheme}: summary starts collapsed`);
      assert.equal(start.sign, '+', `${width}px ${scheme}: plus signals that the card will open`);
      assert.equal(start.hidden, true, `${width}px ${scheme}: full card starts hidden`);
      assert.equal(start.closeCount, 0, `${width}px ${scheme}: no Close button is rendered`);
      assert.ok(start.height >= tapTarget(width), `${width}px ${scheme}: the summary meets the #371 target: ${JSON.stringify(start)}`);
      await saveStatsToggleShot(chrome, width, scheme, 'collapsed');

      await press(chrome, "document.querySelector('#proof-stats-summary')");
      let state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'true', `${width}px ${scheme}: mouse click anywhere on the summary opens the card`);
      assert.equal(state.sign, '−', `${width}px ${scheme}: minus signals that the card will fold`);
      assert.equal(state.hidden, false, `${width}px ${scheme}: full card opens from the summary`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: opening keeps focus on the toggle`);
      assert.equal(state.closeCount, 0, `${width}px ${scheme}: opening adds no Close button`);
      await saveStatsToggleShot(chrome, width, scheme, 'expanded');

      await press(chrome, "document.querySelector('#proof-stats-summary .proof-stats-caret')");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'false', `${width}px ${scheme}: clicking the minus folds the card`);
      assert.equal(state.sign, '+', `${width}px ${scheme}: folded card shows plus`);
      assert.equal(state.hidden, true, `${width}px ${scheme}: minus click hides the full card`);

      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await chrome.waitFor("matchMedia('(pointer: coarse)').matches");
      state = await statsToggleState(chrome);
      assert.ok(state.height >= 44, `${width}px ${scheme}: touch mode keeps a 44px summary target: ${JSON.stringify(state)}`);
      await tapTouch(chrome, "document.querySelector('#proof-stats-summary')");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'true', `${width}px ${scheme}: a real touch opens the card`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: touch keeps focus on the summary`);
      await tapTouch(chrome, "document.querySelector('#proof-stats-summary')");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'false', `${width}px ${scheme}: a second real touch folds the card`);
      const touchTargets = JSON.parse(await chrome.stable('JSON.stringify(window.__statsTouchTargets)'));
      assert.ok(touchTargets.length >= 2 && touchTargets.slice(-2).every(Boolean), `${width}px ${scheme}: real touch pointer events land on the summary: ${JSON.stringify(touchTargets)}`);

      await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await chrome.stable("document.querySelector('#proof-stats-summary').focus()");
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await chrome.waitFor("document.querySelector('#proof-stats-summary')?.getAttribute('aria-expanded') === 'true'");
      state = await statsToggleState(chrome);
      assert.equal(state.hidden, false, `${width}px ${scheme}: Enter opens the focused summary`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: Enter retains focus on the summary`);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ', unmodifiedText: ' ' } : {}) });
      await chrome.waitFor("document.querySelector('#proof-stats-summary')?.getAttribute('aria-expanded') === 'false'");
      state = await statsToggleState(chrome);
      assert.equal(state.hidden, true, `${width}px ${scheme}: Space folds the focused summary`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: Space retains focus on the summary`);
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await chrome.waitFor("document.querySelector('#proof-stats-summary')?.getAttribute('aria-expanded') === 'true'");
      for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await chrome.waitFor("document.querySelector('#proof-stats-full').hidden");
      state = await statsToggleState(chrome);
      assert.equal(state.expanded, 'false', `${width}px ${scheme}: Escape folds the card`);
      assert.equal(state.sign, '+', `${width}px ${scheme}: Escape returns the plus sign`);
      assert.equal(state.focus, 'proof-stats-summary', `${width}px ${scheme}: Escape returns focus to the summary`);
      assert.equal(state.closeCount, 0, `${width}px ${scheme}: the full card still has no Close button`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
