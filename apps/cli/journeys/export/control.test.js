// pullboard: browser
/** @pullboard-test-gui */
/** Export replay placement and behavior in the real static page [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserPause } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { serveFolder } from '../../tests/fixtures/cockpit/harness.js';
import { settled } from '../../tests/fixtures/cockpit/harness.js';

/** Verify the static replay control's placement and live behavior on a real phone-width viewport. */
async function exportReplayControlJourney(t) {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the static replay control proof.');
  const box = machine();
  const board = project(box, 'export replay control');
  box.run(board.repo, 'add', 'web', 'Replay event one');
  box.run(board.repo, 'add', 'web', 'Replay event two');
  const exported = box.exportSnapshot(board.repo, 'export-replay-control');
  const host = await serveFolder(exported.root, '/demo/');
  const profile = join(box.dir, 'export-replay-control-chrome');
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await settled(chrome, "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length");
    const initial = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const controls = document.querySelector('#snapshot-controls');
      const footer = document.querySelector('footer.status');
      const rect = controls.getBoundingClientRect();
      const bar = footer.getBoundingClientRect();
      return { inStatusBar: controls.parentElement === footer, aboveContent: document.querySelector('main').contains(controls),
        readOnly: document.querySelector('#live').textContent, counter: document.querySelector('#replay-progress').textContent,
        counterWidth: document.querySelector('#replay-progress').getBoundingClientRect().width,
        controlRight: rect.right, barRight: bar.right, events: snapshotReplay.events.length,
        speed: [...document.querySelector('#replay-speed').options].map(option => option.value) };
    })())`));
    assert.equal(initial.inStatusBar, true, 'the replay cluster is part of the existing status bar');
    assert.equal(initial.aboveContent, false, 'the exported page content has no replay card above it');
    assert.equal(initial.readOnly, 'read-only', 'the status bar still identifies this as read-only');
    assert.equal(initial.counter, `event ${initial.events.toLocaleString('en-US')} of ${initial.events.toLocaleString('en-US')}`,
      'the status-bar counter names the current event and complete export total');
    assert.ok(initial.counterWidth > 0 && initial.controlRight <= initial.barRight, 'the complete control remains inside the phone-width status bar');
    assert.deepEqual(initial.speed, ['1', '4', '16'], 'all replay speeds remain available');
    assert.ok(initial.events >= 2, 'the fixture has multiple events to play and pause');

    await press(chrome, "document.querySelector('#replay-play')");
    await chrome.waitFor('snapshotReplay.playing && snapshotReplay.index > 0 && snapshotReplay.index < snapshotReplay.events.length');
    const playing = await chrome.stable("document.querySelector('#replay-progress').textContent");
    assert.match(playing, /^event [1-9][0-9,]* of [1-9][0-9,]*$/u, 'the status counter follows the live replay position');
    await press(chrome, "document.querySelector('#replay-pause')");
    await chrome.waitFor('!snapshotReplay.playing');
    const paused = await chrome.stable('snapshotReplay.index');
    const pausedCounter = await chrome.stable("document.querySelector('#replay-progress').textContent");
    assert.equal(pausedCounter, `event ${paused.toLocaleString('en-US')} of ${initial.events.toLocaleString('en-US')}`,
      'the counter stays synchronized with the paused event');
    await browserPause(180);
    assert.equal(await chrome.stable('snapshotReplay.index'), paused, 'Pause holds the displayed event in place');
    assert.deepEqual(chrome.exceptions, [], 'the exported page reports no browser exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
  }
}

test('an exported replay stays in the status bar above no page content [N26]', { timeout: 90_000 }, exportReplayControlJourney);
