// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: chip scroll and named waits [N26]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

test('the roadmap chips keep their scroll through a redraw with wide fonts [N26]', async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Roadmap chip row.');
  const box = machine();
  const alpha = project(box, 'roadmap-chips-wide');
  await box.inProcess(alpha.repo, 'add', 'web', 'Next release item', '--specs', 'G1', '--criterion', 'renders');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.8.7', '--note', 'The next release.', '--reason', 'Arrange fixture release', '--items', '1');
  for (const name of ['0.8.8', '0.8.9', '0.8.10', '0.8.11', '0.8.12', '0.8.13', '0.8.14', '0.8.15', '0.8.16', '0.8.17', '0.8.18', '0.8.19']) {
    await box.inProcess(alpha.repo, 'milestone', 'add', name, '--note', 'Queued after the next release.');
  }
  const view = await startView(box);
  const profile = join(box.dir, 'chrome-profile');
  let chrome;
  /** The chips' release names by their text's own width, measured from the glyphs, not the boxes. */
  const labels = async () => JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#roadmap-releases .roadmap-release > span')].map((e) => { const r = document.createRange(); r.selectNodeContents(e); return [e.textContent, r.getBoundingClientRect().width]; }))"));
  const widths = (list) => JSON.stringify(list.map(([name, width]) => [name, Math.round(width * 100) / 100]));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 13');
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('innerWidth === 375');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelector('#roadmap-releases [aria-current=location]')");
    const before = await labels();
    // The current release's chip is bold, so it is wider than when it is not marked, by an amount that depends on
    // the face: 2px on macOS, 4px on Linux CI (#452). A letter-spacing in em widens every label by the same share of its
    // face on every runner, as the toolbar's test does (#445); the forced face, where a machine has it, adds a wider bold.
    for (const face of ['', 'font-family: Verdana, "DejaVu Sans", "Bitstream Vera Sans", sans-serif !important; ']) {
      const at = `375/${face ? 'forced face' : 'own face'}`;
      await chrome.stable(`(() => { const sheet = document.styleSheets[0]; sheet.insertRule('.roadmap-release, .roadmap-release * { ${face}letter-spacing: .12em !important; }', sheet.cssRules.length); return true; })()`);
      const after = await labels();
      assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name), `${at}: the same chips, widened`);
      assert.ok(after.every(([, width], i) => width >= before[i][1] * 1.1), `${at}: every chip's name is at least 10% wider: ${widths(before)} to ${widths(after)}`);
      // A board refresh redraws the Roadmap with the chips scrolled to their end, where a shorter row would clamp them.
      const kept = JSON.parse(await chrome.stable("(() => { const row = document.querySelector('#roadmap-releases'); row.scrollLeft = row.scrollWidth; const before = [row.scrollLeft, row.querySelector('[aria-current]')?.dataset.roadmapJump]; render(); const now = document.querySelector('#roadmap-releases'); return JSON.stringify([before, [now.scrollLeft, now.querySelector('[aria-current]')?.dataset.roadmapJump]]); })()"));
      assert.ok(kept[0][0] > 0 && kept[1][0] === kept[0][0], `${at}: a redraw keeps the chips exactly where they were scrolled: ${JSON.stringify(kept)}`);
      assert.equal(kept[1][1], kept[0][1], `${at}: the redraw keeps the same chip marked`);
      await chrome.stable("(() => { const sheet = document.styleSheets[0]; sheet.deleteRule(sheet.cssRules.length - 1); document.querySelector('#roadmap-releases').scrollLeft = 0; return true; })()");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
