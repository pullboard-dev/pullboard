// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit demo lane checks, moved from the hold journey [N26,C7]. */
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
} from '../../tests/fixtures/cockpit/lane.js';

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
