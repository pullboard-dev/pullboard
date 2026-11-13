// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks: a sent-back reason reads once [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';

test('a sent-back reason reads once [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for sent-back reason rendering checks');

  const box = machine();
  const alpha = project(box, 'sent-back-reason');
  for (const title of ['Duplicate reason', 'Plain note']) {
    await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'the sent-back note reads clearly');
  }
  const notes = [
    'BEHAVIOR_MISMATCH a78c361: selected-lane exception is unclear',
    'BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains',
  ];
  build(box, alpha, 1, 'duplicate.html');
  sendBack(box, alpha, 1, notes[0]);
  build(box, alpha, 2, 'plain.html');
  sendBack(box, alpha, 2, notes[1]);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-sent-back-reason-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor('document.querySelectorAll("#chain .row").length === 2');
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain .row[data-item="1"] .why')`);
      for (const [id, title, expectedRow, expectedCard] of [
        ['1', 'Duplicate reason', 'Behavior did not match a78c361: selected-lane exception is unclear', 'a78c361: selected-lane exception is unclear'],
        ['2', 'Plain note', 'Behavior did not match BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains', 'BEHAVIOR_MISMATCHED is a separate code-like prefix: the issue remains'],
      ]) {
        await chrome.click(`document.querySelector('#chain .row[data-item="${id}"]')`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('${title}')`);
        const rendered = JSON.parse(await chrome.stable(`JSON.stringify({
          row: [...document.querySelectorAll('#chain .row[data-item="${id}"] .meta :is(.item-reason, .why)')].map((part) => part.textContent).join(' '),
          card: document.querySelector('#detail .sentback .verdict .note')?.textContent,
          reason: document.querySelector('#detail .sentback .verdict b')?.textContent,
          reasonCode: document.querySelector('#detail .sentback .verdict b [title]')?.title,
        })`));
        assert.equal(rendered.row, expectedRow, `${width}px item #${id}: the row shows the readable reason once`);
        assert.equal(rendered.card, expectedCard, `${width}px item #${id}: the card removes only a duplicated leading code`);
        assert.equal(rendered.reason, 'Sent back · Behavior did not match', `${width}px item #${id}: the card retains its verdict heading`);
        assert.equal(rendered.reasonCode, 'BEHAVIOR_MISMATCH', `${width}px item #${id}: the raw verdict reason remains in its tooltip`);
      }
    }
    const storedItems = (await boardOf(view, alpha.repo)).items;
    for (const [index, id] of [1, 2].entries()) {
      assert.equal(storedItems.find((item) => item.id === id).verdict.note, notes[index],
        `rendering leaves item #${id}'s stored verdict unchanged`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
