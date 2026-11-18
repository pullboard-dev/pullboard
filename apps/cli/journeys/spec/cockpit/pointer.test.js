// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit wait, throttle and pointer checks, split from cockpit.test.js [N26,B26,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  watchSpecDecisionWait,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { pressTab } from '../../../tests/fixtures/cockpit/stable.js';
import { watchSpecPress } from '../../../tests/fixtures/cockpit/spec-watch.js';

test('the spec decision wait names its state on timeout [N26]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Spec wait diagnostics.');

  const spec = '# Timeout probe\n\n## G · Goals\n- G1 [draft, must] First goal. | gate: web test\n- G2 [draft, must] Second goal. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-wait-timeout', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-timeout-'));
  let chrome;
  let diagnostics;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await pressTab(chrome, 'spec');
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G1\"]') && !!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    diagnostics = await watchSpecDecisionWait(chrome);
    await press(chrome, `document.querySelector('#spec-list [data-row="spec:G1"]')`);
    await chrome.waitFor("view.row.spec === 'G1' && document.activeElement === document.querySelector('#spec-list')");
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await chrome.waitFor("view.row.spec === 'G2'");

    let timeout;
    try { await diagnostics.waitFor('false', 10); } catch (error) { timeout = error; } // budget: declared 10 ms negative timeout diagnostic deadline.
    assert.match(timeout?.message ?? '', /Browser condition did not arrive: false/, 'the test deliberately drives the real wait helper to timeout');
    assert.deepEqual(timeout.diagnostic.selectedRow, 'G2', 'the timeout record names the currently selected row');
    assert.equal(timeout.diagnostic.focusedElement.id, 'spec-list', 'the timeout record names the focused list');
    assert.ok(Array.isArray(timeout.diagnostic.pendingRequests), 'the timeout record includes bounded in-flight requests');
    assert.deepEqual(timeout.diagnostic.lastKeyEvents.slice(-2).map(({ type, key, code }) => [type, key, code]), [
      ['keydown', 'ArrowDown', 'ArrowDown'], ['keyup', 'ArrowDown', 'ArrowDown'],
    ], 'the timeout record includes the last real key events');
  } finally {
    try { await diagnostics?.dispose(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { rmSync(profile, { recursive: true, force: true }); }
        finally { await view.stop(); }
      }
    }
  }
});

test('the Spec decline opens its reason form under a 6× CPU throttle [N26]', { timeout: 120_000 }, async (t) => { // budget: Chrome startup plus the actual three-second state poll and cleanup under CPU throttling.
  const executable = chromeExecutable();
  assert.ok(executable, 'the required Spec interaction test needs real Chrome');
  const spec = '# Decline under load\n\n## G · Goals\n- G1 [draft, must] Keep the reviewed result visible. | gate: web test\n';
  const box = machine();
  const demo = project(box, 'spec-decline-load', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-decline-load-'));
  let chrome;
  let controlTrace;
  let refreshTrace;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width:375, height:812, deviceScaleFactor:1, mobile:false });
    await chrome.send('Emulation.setCPUThrottlingRate', { rate:6 });
    await pressTab(chrome, 'spec');
    await chrome.waitFor("innerWidth === 375 && !!document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await press(chrome, "document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.waitFor("!!document.querySelector('#spec-detail [data-row-decision=\"decline\"]')");

    const decline = '#spec-detail [data-row-decision="decline"]';
    controlTrace = await watchSpecPress(chrome, decline);
    try {
      await press(chrome, `document.querySelector(${JSON.stringify(decline)})`);
      const control = await controlTrace.snapshot();
      t.diagnostic(`6× no-refresh control: ${JSON.stringify(control)}`);
      assert.equal(control.dialogHidden, false, 'without an intervening refresh the real detail decline opens its reason form');
      assert.deepEqual(control.events.map(event => event.type), ['mousedown', 'mouseup', 'click'], 'the no-refresh control received one native click');
    } finally {
      await controlTrace.dispose();
      controlTrace = null;
    }
    await press(chrome, "document.querySelector('#spec-decline-cancel')");
    await chrome.waitFor("document.querySelector('#spec-decline-dialog').hidden");

    refreshTrace = await watchSpecPress(chrome, decline);
    const refreshText = 'refresh while Spec decline pointer is held';
    let refreshFailure;
    try {
      await press(chrome, `document.querySelector(${JSON.stringify(decline)})`, { afterMouseDown: async () => {
        box.run(demo.repo, 'shout', 'person', refreshText);
        await chrome.waitFor(`data.project.shouts.some(shout => shout.shout_text === ${JSON.stringify(refreshText)})`, 20_000); // budget: hang-only ceiling for the real view poll to carry the private CLI write while native mouse input is held; no throughput claim.
        t.diagnostic(`6× pointer-held refresh before mouseup: ${JSON.stringify(await refreshTrace.snapshot())}`);
      } });
    } catch (error) {
      refreshFailure = error;
    }
    let refreshed;
    try {
      refreshed = await refreshTrace.snapshot();
      t.diagnostic(`6× pointer-held refresh after mouseup: ${JSON.stringify(refreshed)}`);
    } catch (error) {
      t.diagnostic(`6× pointer-held refresh snapshot failed: ${error.message}`);
      if (!refreshFailure) refreshFailure = error;
    }
    if (refreshFailure) throw refreshFailure;
    assert.equal(refreshed.dialogHidden, false, 'the real Spec decline still opens its reason form when a board refresh arrives during the native press');
    assert.ok(refreshed.events.some(event => event.type === 'click'), `the native release produced a click after the refresh: ${JSON.stringify(refreshed)}`);
    await refreshTrace.dispose();
    refreshTrace = null;
  } finally {
    try { await refreshTrace?.dispose(); }
    finally {
      try { await controlTrace?.dispose(); }
      finally {
        try { if (chrome) await closeSnapshotChrome(chrome); }
        finally {
          try { await view.stop(); }
          finally { rmSync(profile, { recursive:true, force:true }); }
        }
      }
    }
  }
});

/** The decline dialog's submit button keeps its place while the dialog is open, with an approval note in the list above it. */
test('the decline dialog never moves under the pointer [B26,N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to check the decline dialog.');

  // A long list at a phone width: the page ends below the detail, so removing a note above it clamps the page's scroll.
  const rows = Array.from({ length: 24 }, (_, index) => `- G${index + 1} [draft, must] Row ${index + 1} keeps its wording. | gate: review`);
  const spec = '# Decline stability\n\n## G · Goals\n' + rows.join('\n') + '\n';
  const box = machine();
  project(box, 'decline-stable', spec);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-decline-stable-chrome-'));
  let chrome;
  /** One key press, as the keyboard sends it to the focused list. */
  const pressKey = async (key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === 'keyDown' && key.length === 1 ? { text: key, unmodifiedText: key } : {}) });
  };
  /** The page's scroll and the decline dialog's submit button's box, read in one step. */
  const measure = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const r = document.querySelector('#spec-decline-submit').getBoundingClientRect();
    return { y: scrollY, box: [r.x, r.y, r.width, r.height] };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await chrome.waitFor('data?.project?.spec?.length === 24');
    await pressTab(chrome, 'spec');
    await chrome.click("document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
    await chrome.waitFor("!!document.querySelector('#spec-list [data-row=\"spec:G2\"]')");
    // Approving G1 from the list leaves a note in the list; the decline for the next row opens inside that window.
    await chrome.click("document.querySelector('#spec-list [data-row=\"spec:G1\"]')");
    await chrome.stable("document.querySelector('#spec-list').focus();true");
    await pressKey('a', 'KeyA', 65);
    await chrome.waitFor("!!document.querySelector('#spec-list .spec-feedback.ok')");
    await chrome.stable('window.scrollTo(0, document.documentElement.scrollHeight);true');
    await pressKey('d', 'KeyD', 68);
    await chrome.waitFor("!document.querySelector('#spec-decline-dialog').hidden && document.querySelector('#spec-decline-title').textContent === 'Decline G2'");
    assert.equal(await chrome.stable("!!document.querySelector('#spec-list .spec-feedback.ok')"), true, 'the approval note is still in the list when the dialog opens');
    await chrome.send('Input.insertText', { text: 'a reason' });
    const opened = await measure();

    // The note stays until the next pick or decision (no timer removes it), so the page cannot shift under the pointer.
    await new Promise((resolve) => setTimeout(resolve, 7000)); // budget: the old six-second window, plus a second of slack
    assert.equal(await chrome.stable("!!document.querySelector('#spec-list .spec-feedback.ok')"), true, 'the approval note is still in the list while the dialog is open');
    assert.deepEqual(await measure(), opened, 'nothing moves while the dialog waits for its press');

    // The press itself: record the page and the button at pointer down, then press with the real mouse.
    await chrome.stable("window.__pressAt = null; document.addEventListener('pointerdown', (event) => { if (event.target.closest('#spec-decline-submit')) window.__pressAt = JSON.stringify({ y: scrollY, box: (() => { const r = document.querySelector('#spec-decline-submit').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() }); }, { capture: true });true");
    await press(chrome, "document.querySelector('#spec-decline-submit')");
    const pressed = JSON.parse(await chrome.stable('window.__pressAt'));
    assert.deepEqual(pressed, opened, 'the page and the submit button are where the person aimed when the press lands');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); rmSync(profile, { recursive: true, force: true }); await view.stop(); }
});
