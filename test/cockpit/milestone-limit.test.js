// pullboard: browser
/** @pullboard-test-gui */
/** Real roadmap capacity labels remain visible for active, empty and shipped milestones [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

test('the view names a milestone limit only near capacity, including empty and shipped plans [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for milestone capacity labels.');
  const box = machine(), alpha = project(box, 'milestone-caps');
  box.run(alpha.repo, 'add', 'web', 'Release work', '--specs', 'G1', '--criterion', 'Ready.');
  box.run(alpha.repo, 'milestone', 'add', 'Active', '--reason', 'Arrange fixture release', '--items', '1');
  box.run(alpha.repo, 'milestone', 'edit', 'Active', '--limit', '2');
  for (const name of ['Empty', 'Shipped']) {
    box.run(alpha.repo, 'milestone', 'add', name);
    box.run(alpha.repo, 'milestone', 'edit', name, '--limit', '0');
  }
  box.run(alpha.repo, 'milestone', 'ship', 'Shipped');
  box.run(alpha.repo, 'milestone', 'add', 'Unlimited');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-capacity-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("document.querySelector('[data-tab=roadmap]')");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelector('[data-key=\"m:Active\"] .milestone-limit')");
    for (const width of [320, 375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const labels = JSON.parse(await chrome.stable(`JSON.stringify(['Active','Empty','Shipped','Unlimited'].map(name => document.querySelector('[data-key="m:'+name+'"] .milestone-limit')?.textContent ?? null))`));
      assert.deepEqual(labels, ['1 item', '0 items · limit 0', '0 items · limit 0', null], String(width));
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
