// pullboard: browser
/** @pullboard-test-gui */
/** Native ordinary lifecycle returns retain their exact projected counts in Chrome [N26,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedNativeOrdinary } from '../../tests/fixtures/cockpit/lifecycle/seed/ordinary.js';
import {
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

test('native release, escalation, retained and expired refreezes and lapse retain their own chart counts [N26,C7]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for native return counts');
  const box = machine(), demo = project(box, 'lifecycle-returns');
  const { kept, expected } = seedNativeOrdinary(box, demo);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-lifecycle-returns-chrome-'));
  let chrome;
  try {
    const native = await boardOf(view, demo.repo);
    for (const [route, count] of Object.entries(expected)) assert.equal(native.moveCounts[route], count, 'authenticated native count: ' + route);
    const correction = native.items.find(item => item.id === kept);
    assert.equal(correction.status, 'claimed');
    assert.equal(correction.history.findLast(event => event.kind === 'refreeze').retainedClaim, true);
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(demo.repo));
    await press(chrome, "document.querySelector('[data-tab=activity]')");
    await press(chrome, "document.querySelector('#flow-show')");
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width + ' && !!document.querySelector("#flow svg")');
      const visibleCounts = JSON.parse(await chrome.stable('JSON.stringify(data.project.moveCounts)'));
      for (const [route, count] of Object.entries(expected)) assert.equal(visibleCounts[route], count, width + ': browser retains exact native route ' + route);
      const words = await chrome.stable('document.querySelector(".lifecycle-notes").textContent');
      for (const phrase of ['1 let go', '1 moved to a stronger agent', '1 check re-frozen', '1 went idle', '1 checks re-frozen while building']) {
        assert.ok(words.includes(phrase), width + ': ' + phrase);
      }
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'), true, width + ': no document overflow');
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
