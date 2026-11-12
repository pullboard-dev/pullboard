// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit demo checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openShoutConversation,
  SPEC,
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  allowLiveHold,
  holdLive,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  armLaneReleaseCapture,
  finishLaneReleaseCapture,
  includeLaneReleaseCapture,
} from '../../tests/fixtures/cockpit/lane.js';
import {
  stageNaturalSpecChips,
  measureNaturalSpecChips,
} from '../../tests/fixtures/cockpit/stable.js';

/** Release a completed real hold refresh at the next pointer aim, reproducing the captured late console scroll. */
test('a finished lane hold does not scroll after the next press is aimed [N26,C7]', {
  timeout: 60_000, // budget: bound a hung real browser journey, not the duration of a successful request.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the late action scroll control');
  const box = machine();
  const demo = project(box, 'late-hold-demo');
  project(box, 'other-late-hold-demo');
  box.run(demo.repo, 'add', 'web', 'Hold control', '--specs', 'G1', '--criterion', 'the next press remains where it was aimed');
  box.run(demo.repo, 'shout', 'person', 'Should the hold control ship?', '--decision');
  // The captured desktop journey follows phone and desktop shouts; keep that real feed tall enough to scroll.
  for (const text of ['Phone shout 375', 'Phone answer 375', 'Phone shout 1280', 'Phone answer 1280']) {
    box.run(demo.repo, 'shout', 'web', text);
  }
  for (let index = 0; index < 8; index++) box.run(demo.web, 'shout', 'all', 'Earlier board discussion ' + index);
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-late-hold-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    // Keep this one real refresh under test control; every HTTP response and render remains real (#622).
    await allowLiveHold(chrome);
    await chrome.send('Page.navigate', { url: view.link.href });
    await holdLive(chrome, 'data?.project?.items.some(item => item.title === "Hold control")');
    await press(chrome, 'document.querySelector("[data-tab=shouts]")');
    await openShoutConversation(chrome);
    await chrome.stable(`(() => {
      const originalRefresh = refresh;
      window.__lateHold = { ready: false, aimed: false, completed: false };
      /** Pause only the continuation after the real hold state has rendered. */
      refresh = async function() {
        await originalRefresh();
        refresh = originalRefresh;
        window.__lateHold.ready = true;
        await new Promise(resolve => { window.__lateHold.finish = resolve; });
        window.__lateHold.completed = true;
      };
      document.querySelector('#hold-lane').value = 'web';
      document.querySelector('#hold-reason').value = 'Keep the next press steady';
      document.querySelector('#hold-form').requestSubmit();
    })()`);
    await chrome.waitFor('window.__lateHold.ready && !!document.querySelector("#lanes [data-release=web]")');
    const geometry = JSON.parse(await chrome.stable(`JSON.stringify({ height: innerHeight,
      pageHeight: document.documentElement.scrollHeight, scrollY,
      console: document.querySelector('#console').getBoundingClientRect().toJSON(),
      success: document.querySelector('#console').classList.contains('ok') })`));
    t.diagnostic('late hold geometry: ' + JSON.stringify(geometry));
    assert.ok(geometry.pageHeight > geometry.height, 'the real feed can scroll, so a redundant scroll cannot pass vacuously');
    assert.ok(geometry.success && geometry.console.height > 0 && geometry.console.top >= 0 && geometry.console.bottom <= geometry.height,
      'the hold result is already visible before its refresh continuation resumes');
    await chrome.stable(`(() => {
      /** Finish the previous action exactly after Chrome aims at the next real button. */
      function finishAtAim(event) {
        if (!event.target.closest('#lanes [data-release=web]')) return;
        document.removeEventListener('pointermove', finishAtAim, true);
        window.__lateHold.aimed = true;
        window.__lateHold.before = scrollY;
        window.__lateHold.finish();
      }
      document.addEventListener('pointermove', finishAtAim, true);
    })()`);
    const captureSetup = await armLaneReleaseCapture(chrome, '#lanes [data-release=web]');
    try {
      await press(chrome, 'document.querySelector("#lanes [data-release=web]")');
    } finally {
      const capture = await finishLaneReleaseCapture(chrome, captureSetup);
      t.diagnostic('late hold continuation: ' + JSON.stringify(capture));
    }
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify({ aimed: window.__lateHold.aimed, completed: window.__lateHold.completed })')),
      { aimed: true, completed: true }, 'the real completed refresh resumed after pointer aim');
    await chrome.waitFor('!document.querySelector("#lanes [data-release=web]")');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the spec chip measurement survives a redraw [N26,C7]', {
  timeout: 30_000, // budget: stop a hung local Chrome flow; not a rendering-speed assertion.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is installed or PULLBOARD_CHROME points to it');

  const box = machine();
  const demo = project(box, 'spec-chip-redraw-demo');
  box.run(demo.repo, 'add', 'web', 'Spec chip measurement item', '--specs', 'G1', '--criterion', 'visible in the Spec chip redraw test');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-spec-chip-redraw-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('[data-tab=items]')");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('#chain .row')");
    await press(chrome, "document.querySelector('[data-tab=spec]')");
    await chrome.waitFor("document.querySelectorAll('#spec-chips button:not([data-natural-chip])').length >= 2");

    let redraw;
    /** Reproduce the prior split-operation boundary with a real chip click and record why its samples differ. */
    const forceRedrawAtMeasurementBoundary = async () => {
      const staged = await stageNaturalSpecChips(chrome);
      assert.ok(staged.buttonCount >= 2, `Spec filters render as chips: ${JSON.stringify(staged)}`);
      assert.equal(staged.cloneCount, staged.buttonCount, `staging begins with matching buttons and clones: ${JSON.stringify(staged)}`);
      await press(chrome, "document.querySelector('#spec-chips [data-rows=\"spec:all\"]')");
      await chrome.waitFor("document.querySelectorAll('#spec-chips button:not([data-natural-chip])').length >= 2");
      redraw = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const stage = window.__specChipStage;
        const root = document.querySelector('#spec-chips');
        return {
          stagedButtonsConnected: stage.buttons.every(button => button.isConnected),
          stagedClonesConnected: stage.clones.every(clone => clone.isConnected),
          buttonCount: root.querySelectorAll('button:not([data-natural-chip])').length,
          cloneCount: root.querySelectorAll('[data-natural-chip]').length,
        };
      })())`));
      assert.equal(redraw.stagedButtonsConnected, false, `the actual filter click redrew the chip buttons: ${JSON.stringify(redraw)}`);
      assert.equal(redraw.stagedClonesConnected, false, `that redraw dropped the staged clones: ${JSON.stringify(redraw)}`);
      assert.equal(redraw.buttonCount, staged.buttonCount, `the current chip count stayed stable: ${JSON.stringify(redraw)}`);
      assert.equal(redraw.cloneCount, 0, `the redraw removed the staged clones rather than changing the chip count: ${JSON.stringify(redraw)}`);
    };

    const measured = await measureNaturalSpecChips(chrome, forceRedrawAtMeasurementBoundary);
    assert.ok(measured.buttonCount > 0, `Spec chip measurement found ${measured.buttonCount} buttons and ${measured.cloneCount} clones`);
    assert.equal(measured.cloneCount, measured.buttonCount, `the current buttons are cloned and measured together: ${JSON.stringify(measured)}`);
    assert.equal(measured.chips.length, measured.buttonCount, `every current Spec chip has a measurement: ${JSON.stringify(measured)}`);
    for (const chip of measured.chips) assert.ok(Math.abs(chip.actualWidth - chip.naturalWidth) < 2,
      `${chip.text} keeps its natural width after redraw: ${JSON.stringify(chip)}`);
    assert.equal(await chrome.stable("document.querySelectorAll('#spec-chips [data-natural-chip]').length"), 0,
      'natural-size clones are removed after measurement');
    assert.deepEqual(chrome.exceptions, [], 'the browser reports no page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the lanes panel fits its card at every width [N26]', {
  timeout: 120_000, // budget: hang ceiling for real Chrome startup and eight viewport and scheme layouts of one side card.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is installed or PULLBOARD_CHROME points to it');
  const box = machine();
  const demo = project(box, 'lanes-panel-fit', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, review: { owns: ['review/'], specs: [] } } });
  // A holder whose name is longer than the README demo's "coordinator (Demo coordinator)", which already overflowed.
  const model = 'Demo coordinator with a long model name';
  box.run(demo.repo, 'join', 'coordinator', '--model', model);
  box.run(demo.repo, 'hold', 'review', '--reason', 'Waiting for the next demo item.');
  const held = `held by coordinator (${model})`;
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-lanes-panel-'));
  let chrome;
  /** The card's content box, its sideways scroll and the page's, the holder chip, and every lane and form box that leaves the content box. */
  const measure = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const card = document.querySelector('#shouts-pane aside[aria-label="Agents and lanes"]'), s = getComputedStyle(card), r = card.getBoundingClientRect();
    const left = r.left + card.clientLeft + parseFloat(s.paddingLeft), right = r.left + card.clientLeft + card.clientWidth - parseFloat(s.paddingRight);
    const name = (e) => e.id ? '#' + e.id : (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : e.tagName.toLowerCase()) + (e.textContent.trim() ? ' "' + e.textContent.trim().slice(0, 24) + '"' : '');
    const boxes = [...card.querySelectorAll('#lanes .lane, #lanes .lane *, #hold-form, #hold-form *')].filter((e) => e.getClientRects().length).map((e) => [name(e), e.getBoundingClientRect()]);
    const past = boxes.filter(([, b]) => b.left < left - 0.5 || b.right > right + 0.5).map(([n, b]) => [n, Math.round(b.left), Math.round(b.right)]);
    const chip = card.querySelector('#lanes [data-release="review"]')?.closest('.lane')?.querySelector('.chip'), cs = chip && getComputedStyle(chip);
    const form = card.querySelector('#hold-form'), widths = ['#hold-form', '#hold-lane', '#hold-reason', '#hold-form button[type=submit]'].map((q) => Math.round(card.querySelector(q).getBoundingClientRect().width * 10) / 10);
    return { content: [Math.round(left), Math.round(right)], column: s.gridTemplateColumns, card: [card.scrollWidth, card.clientWidth], page: [Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), document.documentElement.clientWidth],
      chip: chip && { text: chip.textContent.trim(), title: chip.title, wraps: cs.whiteSpace === 'normal', ellipsis: cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden', clipped: chip.scrollWidth > chip.clientWidth },
      widths, past };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 1440');
    await press(chrome, "document.querySelector('[data-tab=shouts]')");
    await chrome.waitFor("!!document.querySelector('#shouts-pane:not([hidden]) #lanes [data-release=review]')");
    for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`document.documentElement.dataset.scheme === '${scheme}'`);
      for (const width of [375, 900, 1280, 1440]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.waitFor(`innerWidth === ${width}`);
        const at = `${width}/${scheme}`, m = await measure();
        assert.deepEqual(m.past, [], `${at}: every lane and form control stays inside the card's content box ${m.content}: ${JSON.stringify(m)}`);
        assert.ok(m.card[0] <= m.card[1] && m.page[0] <= m.page[1], `${at}: neither the card nor the page scrolls sideways: ${JSON.stringify(m)}`);
        assert.equal(m.chip.text, held, `${at}: the chip names the whole holder`);
        assert.ok(m.chip.wraps || (m.chip.ellipsis && m.chip.title === held), `${at}: a long holder wraps, or ends in an ellipsis with the full name on hover: ${JSON.stringify(m.chip)}`);
        assert.ok(m.widths.every((w) => Math.abs(w - (m.content[1] - m.content[0])) <= 1), `${at}: the hold form, its lane, its reason and its button take the card's width ${m.content[1] - m.content[0]}: ${m.widths}`);
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a moved press target names the element that moved it [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:18px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      document.body.prepend(spacer, standIn, target);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); standIn.remove(); target.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable('JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false })'));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after)
      && capture.page.scrollY.before !== capture.page.scrollY.after,
      `the failure capture records the native scroll-anchor adjustment before and after the press: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a removed lane-release target still cleans up its capture [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one target-removal cleanup check.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the removed-target cleanup check.');

  const box = machine();
  project(box, 'removed-press-target');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-removed-press-'));
  let chrome, captureSetup = null, captureFinishAttempted = false;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("document.readyState === 'complete' && !!document.body");
    await chrome.stable(`(() => {
      const target = document.createElement('button');
      target.id = 'removed-press-target';
      target.type = 'button';
      target.textContent = 'Temporary target';
      document.body.append(target);
      window.__removedPressOriginalScrollIntoView = Element.prototype.scrollIntoView;
    })()`);
    captureSetup = await armLaneReleaseCapture(chrome, '#removed-press-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the capture arms before its target is removed: ${JSON.stringify(captureSetup)}`);

    await chrome.stable("document.querySelector('#removed-press-target').remove()");
    captureFinishAttempted = true;
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    assert.equal(capture.pageError, null, `finishing after target removal does not throw: ${JSON.stringify(capture)}`);
    const removed = capture.page?.changedNodes.find((entry) => entry.node.id === 'removed-press-target');
    assert.equal(removed?.last.connected, false, `the bounded sample records that its target disappeared: ${JSON.stringify(capture.page?.changedNodes)}`);
    const cleanup = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const state = { captureInstalled: Boolean(window.__laneReleaseCapture), scrollIntoViewRestored:
        Element.prototype.scrollIntoView === window.__removedPressOriginalScrollIntoView };
      delete window.__removedPressOriginalScrollIntoView;
      return state;
    })())`));
    assert.deepEqual(cleanup, { captureInstalled: false, scrollIntoViewRestored: true },
      `the finish path removes its global and restores the native method: ${JSON.stringify(cleanup)}`);
  } finally {
    if (chrome) {
      if (captureSetup && !captureFinishAttempted) await finishLaneReleaseCapture(chrome, captureSetup).catch(() => undefined);
      await chrome.stable('delete window.__removedPressOriginalScrollIntoView').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a moved press target names a rendered-above box later in DOM order [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:18px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      group.append(target, standIn);
      document.body.prepend(spacer, group);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      return { above: above.getBoundingClientRect().bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })())`));
    assert.deepEqual(order, { above: true, later: true }, 'the box renders above the target despite following it in DOM order');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable('JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false })'));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a zero-height box above a moved target keeps its old geometry [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:0px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      const below = Array.from({ length: 12 }, (_, index) => {
        const node = document.createElement('div');
        node.id = 'press-below-' + index;
        node.style.cssText = 'height:0px;order:1;overflow-anchor:none';
        return node;
      });
      group.append(target, standIn, ...below);
      document.body.prepend(spacer, group);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
          below.forEach(node => { node.style.height = '12px'; });
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      const before = above.getBoundingClientRect();
      return { above: before.bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING),
        before: { top: before.top, documentTop: before.top + scrollY, height: before.height } };
    })())`));
    assert.deepEqual({ above: order.above, later: order.later, height: order.before.height }, { above: true, later: true, height: 0 },
      'the initially zero-height box is physically above the target but later in DOM order');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable(`JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false,
      targetTop: document.querySelector('#press-move-target').getBoundingClientRect().top,
      below: [...document.querySelectorAll('[id^="press-below-"]')].map(node => ({
        top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })) })`));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.ok(moved.first, 'a box growing from zero above target retains old top/height: ' + failureText);
    assert.deepEqual({ top: moved.first.top, documentTop: moved.first.documentTop, height: moved.first.height }, order.before,
      'old top and height are the actual measurements before aim');
    assert.equal(moved.last.height, 98, 'the new height is the actual grown box');
    assert.equal(fixture.below.length, 12);
    assert.ok(fixture.below.every(box => box.height === 12 && box.top > fixture.targetTop),
      'twelve other zero-height boxes really grew below the target');
    assert.ok(changed.every(entry => !entry.node.id.startsWith('press-below-')),
      'below-target changes cannot crowd the rendered-above diagnostic');
    assert.equal(capture.page.truncated.remainingChangedNodes, 0, 'below-target growth does not consume the ten-detail allowance');
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('below-target boxes cannot crowd the above-target aim cache [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:0px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      const below = Array.from({ length: 2001 }, (_, index) => {
        const node = document.createElement('div');
        node.id = 'press-below-' + index;
        node.style.cssText = 'height:0px;order:1;overflow-anchor:none';
        return node;
      });
      group.append(...below, target, standIn);
      for (const existing of document.body.children) existing.hidden = true;
      const tail = document.createElement('div');
      tail.style.cssText = 'height:1100px;overflow-anchor:none';
      document.body.prepend(spacer, group, tail);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
          below.forEach(node => { node.style.height = '12px'; });
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); tail.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      const before = above.getBoundingClientRect();
      return { above: before.bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING),
        before: { top: before.top, documentTop: before.top + scrollY, height: before.height } };
    })())`));
    assert.deepEqual({ above: order.above, later: order.later, height: order.before.height }, { above: true, later: true, height: 0 },
      'the initially zero-height box is physically above the target but later in DOM order');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const fixture = JSON.parse(await chrome.stable(`JSON.stringify({ grew: window.__pressMoveFixture?.grew() ?? false,
      targetTop: document.querySelector('#press-move-target').getBoundingClientRect().top,
      below: [...document.querySelectorAll('[id^="press-below-"]')].map(node => ({
        top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })) })`));
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.ok(fixture.grew, 'the stand-in box grows during the shared press pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.ok(moved.first, 'a box growing from zero above target retains old top/height: ' + failureText);
    assert.deepEqual({ top: moved.first.top, documentTop: moved.first.documentTop, height: moved.first.height }, order.before,
      'old top and height are the actual measurements before aim');
    assert.equal(moved.last.height, 98, 'the new height is the actual grown box');
    assert.equal(fixture.below.length, 2001);
    assert.ok(fixture.below.every(box => box.height === 12 && box.top > fixture.targetTop),
      '2001 DOM-earlier zero-height boxes really grew below the target');
    assert.ok(changed.every(entry => !entry.node.id.startsWith('press-below-')),
      'below-target changes cannot crowd the rendered-above diagnostic');
    assert.equal(capture.page.truncated.droppedByReason.nodeLimit, 0, 'unrelated below-target boxes never consume the aim cache');
    assert.equal(capture.page.truncated.remainingChangedNodes, 0, 'below-target growth does not consume the ten-detail allowance');
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('the above-target aim cache counts boxes beyond its limit [N26,C7]', {
  timeout: 120_000, // budget: hang-only ceiling for real Chrome startup and one deterministic pointer-movement capture.
}, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the moved-press capture.');

  const box = machine();
  project(box, 'moved-press-capture');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-moved-press-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor("innerWidth === 375 && document.readyState === 'complete' && !!document.querySelector('#lanes')");
    await chrome.stable(`(() => {
      const standIn = document.createElement('div');
      standIn.id = 'press-move-stand-in';
      standIn.style.cssText = 'height:0px;background:#ddd;overflow-anchor:none';
      const target = document.createElement('button');
      target.id = 'press-move-target';
      target.type = 'button';
      target.textContent = 'Press target';
      target.style.cssText = 'display:block;height:44px;overflow-anchor:auto';
      const spacer = document.createElement('div');
      spacer.style.cssText = 'height:1100px;overflow-anchor:none';
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;overflow-anchor:auto';
      standIn.style.order = '-1';
      target.style.order = '0';
      const extraAbove = Array.from({ length: 2001 }, (_, index) => {
        const node = document.createElement('div');
        node.id = 'press-extra-above-' + index;
        node.style.cssText = 'height:0px;order:-2;overflow-anchor:none';
        return node;
      });
      group.append(target, standIn, ...extraAbove);
      for (const existing of document.body.children) existing.hidden = true;
      const tail = document.createElement('div');
      tail.style.cssText = 'height:1100px;overflow-anchor:none';
      document.body.prepend(spacer, group, tail);
      let grew = false;
      const growAboveTarget = event => {
        if (!grew && event.target === target) {
          grew = true;
          standIn.style.height = '98px';
        }
      };
      document.addEventListener('pointermove', growAboveTarget, true);
      window.__pressMoveFixture = { grew: () => grew, cleanup() {
        document.removeEventListener('pointermove', growAboveTarget, true);
        spacer.remove(); group.remove(); tail.remove(); delete window.__pressMoveFixture;
      } };
      return { standIn: standIn.id, target: target.id };
    })()`);
    const order = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const above = document.querySelector('#press-move-stand-in');
      const target = document.querySelector('#press-move-target');
      const before = above.getBoundingClientRect();
      return { above: before.bottom <= target.getBoundingClientRect().top,
        later: Boolean(target.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING),
        before: { top: before.top, documentTop: before.top + scrollY, height: before.height } };
    })())`));
    assert.deepEqual({ above: order.above, later: order.later, height: order.before.height }, { above: true, later: true, height: 0 },
      'the initially zero-height box is physically above the target but later in DOM order');
    const overflowGeometry = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const targetTop = document.querySelector('#press-move-target').getBoundingClientRect().top;
      const extras = [...document.querySelectorAll('[id^="press-extra-above-"]')];
      return { count: extras.length, allAbove: extras.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.height === 0 && rect.top <= targetTop;
      }) };
    })())`));
    assert.deepEqual(overflowGeometry, { count: 2001, allAbove: true }, 'all overflow boxes really render above the target');
    const captureSetup = await armLaneReleaseCapture(chrome, '#press-move-target', 'document.documentElement');
    assert.equal(captureSetup.armed, true, `the named stand-in target is present before the shared press: ${JSON.stringify({ armed: captureSetup.armed, error: captureSetup.error ?? null })}`);
    let pressError = null;
    try { await press(chrome, "document.querySelector('#press-move-target')"); }
    catch (error) { pressError = error; }
    const capture = await finishLaneReleaseCapture(chrome, captureSetup);
    const changed = capture.page?.changedNodes ?? [];
    const moved = changed.find(node => node.node?.id === 'press-move-stand-in');
    const captureDetail = { capture, captureError: null };
    if (pressError) includeLaneReleaseCapture(pressError, captureDetail);
    const failureText = `${pressError?.message ?? 'shared press unexpectedly completed without an error'}; lane-release capture: ${JSON.stringify(captureDetail)}`;
    assert.equal(await chrome.stable('window.__pressMoveFixture.grew()'), true, 'the stand-in really grows during pointer movement');
    assert.ok(pressError, 'the unchanged shared press refuses the moved target instead of clicking it');
    assert.equal(pressError.code, 'ERR_ASSERTION', `the shared press keeps its native assertion failure: ${pressError.message}`);
    assert.match(pressError.message, /shared press: target stays under the pointer/,
      `the refusal comes from the shared press geometry guard: ${pressError.message}`);
    assert.equal(capture.pageError, null, `the page capture finishes without a probe error: ${failureText}`);
    assert.equal(capture.page?.armed, true, `the capture returns its completed page observations: ${failureText}`);
    assert.ok(moved, `the failure capture names the changed box and its old/new geometry: ${failureText}`);
    assert.ok(moved.first, 'a box growing from zero above target retains old top/height: ' + failureText);
    assert.deepEqual({ top: moved.first.top, documentTop: moved.first.documentTop, height: moved.first.height }, order.before,
      'old top and height are the actual measurements before aim');
    assert.equal(moved.last.height, 98, 'the new height is the actual grown box');
    assert.equal(capture.page.observedNodes, 2000, 'the aim cache retains at most 2000 above-target boxes');
    assert.equal(capture.page.truncated.droppedByReason.nodeLimit, 3, '2001 extra above boxes plus the spacer and stand-in drop exactly three');
    assert.equal(capture.page.truncated.remainingChangedNodes, 0, 'unchanged overflow boxes do not create changed-box remainder');
    assert.equal(moved.first.id, 'press-move-stand-in', `the captured old box is the named stand-in: ${failureText}`);
    assert.ok([moved.first.top, moved.first.height, moved.last.top, moved.last.height].every(Number.isFinite),
      `the named box has finite old/new top and height measurements: ${failureText}`);
    assert.notEqual(moved.first.height, moved.last.height, `the captured stand-in height changed: ${failureText}`);
    assert.ok(capture.page.changedNodes.length <= 10 && Number.isInteger(capture.page.truncated.remainingChangedNodes),
      `the failure capture caps box details at ten and counts the remainder: ${failureText}`);
    assert.ok(Number.isFinite(capture.page.scrollY.before) && Number.isFinite(capture.page.scrollY.after),
      `the failure capture records scroll positions even when flex layout moves the target without scrolling: ${failureText}`);
    assert.match(pressError.message, /lane-release capture: .*press-move-stand-in.*scrollY.*before.*after/s,
      `the failed press message carries the changed box and scroll positions: ${failureText}`);
    assert.match(pressError.message, /remainingChangedNodes/, `the failure message reports the count of other changed boxes: ${failureText}`);
    assert.ok(Object.hasOwn(capture.page, 'scrollAnchoring'), `the capture records whether Chromium reported an anchor: ${failureText}`);
  } finally {
    if (chrome) {
      await chrome.stable('window.__pressMoveFixture?.cleanup()').catch(() => undefined);
      await closeSnapshotChrome(chrome);
    }
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
