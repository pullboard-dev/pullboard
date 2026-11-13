// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (pipeline click delivery), using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
  startView,
  target,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  settled,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';

import { pipelineBoard } from '../../../tests/fixtures/cockpit/pipeline.js';
import { installPipelinePressDiagnostics } from '../../../tests/fixtures/cockpit/pipeline.js';
import { waitForPipelineItem } from '../../../tests/fixtures/cockpit/pipeline.js';

/** A real card press records click delivery, Pipeline redraws and address selection under CPU throttling [N26,N38,C7]. */
test('the pipeline opens the clicked item under a 6× CPU throttle [N26,N38,C7]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one browser journey at the declared 6× CPU load.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the throttled Pipeline click diagnostic');
  const box = machine(), alpha = project(box, 'pipeline-click-under-load');
  pipelineBoard(box, alpha);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-click-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-page-ctl=view][data-value=pipeline]')");
    await chrome.waitFor("location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await installPipelinePressDiagnostics(chrome);
    const id = 2;
    const selector = `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`;
    const armed = await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(${selector})`);
    assert.deepEqual(armed, { dataItem: String(id), connected: true, disabled: false }, 'the intended real card is present and enabled before press');
    let failure = null;
    try {
      await press(chrome, selector);
      await chrome.waitFor(`(() => { const evidence = globalThis.__pipelinePressDiagnostic.snapshot(); globalThis.__pipelinePressDiagnostic.last = evidence; return evidence.viewItem === ${id}; })()`, 15_000); // budget: hang ceiling for the clicked item to reach its detail, not a speed target.
    } catch (error) {
      failure = error;
    }
    const evidence = JSON.parse(await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic.last || globalThis.__pipelinePressDiagnostic.snapshot())'));
    assert.equal(failure, null, `${failure?.message || 'the selected item matched'}; Pipeline click evidence: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.down?.dataItem, String(id), `the mousedown reached the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.up?.dataItem, String(id), `the mouseup remained on the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.dataItem, String(id), `the real click reached the intended card: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.viewItem, id, `the intended item is selected: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pathname, `/items/${id}`, `the address names the intended item: ${JSON.stringify(evidence)}`);
    await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
    t.diagnostic(`375px 6× Pipeline click: ${JSON.stringify(evidence)}`);
    assert.deepEqual(chrome.exceptions, [], 'the throttled Pipeline click has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});

/** A real API refresh while the pointer is held must leave the pressed Pipeline card for its click. */
test('a refresh between pointer down and up does not lose the click [N26,N38,C7]', { timeout: 120_000 }, async (t) => { // budget: hang ceiling for one native press and forced local refresh; no speed threshold.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the held-pointer refresh journey');
  const box = machine(), alpha = project(box, 'pipeline-refresh-under-press');
  pipelineBoard(box, alpha);
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-refresh-press-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-page-ctl=view][data-value=pipeline]')");
    await chrome.waitFor("location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await installPipelinePressDiagnostics(chrome);
    await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(document.querySelector('#pipeline .pipeline-item[data-item="2"]'))`);
    let refreshObservation;
    await press(chrome, "document.querySelector('#pipeline .pipeline-item[data-item=\"2\"]')", {
      afterMouseDown: async () => {
        const title = 'A new item arrives during the held Pipeline press';
        await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Refresh the board while a card is pressed');
        refreshObservation = JSON.parse(await chrome.stable(`(async () => {
          await refresh();
          const old = globalThis.__pipelinePressDiagnostic.down?.node;
          const press = globalThis.__pipelinePressDiagnostic.snapshot();
          const observation = { fetchedNewItem: data.project.items.some(item => item.title === ${JSON.stringify(title)}),
            originalCardConnectedWhileHeld: Boolean(old?.isConnected), selected: view.item, pathname: location.pathname, innerWidth,
            pipelineRedrawsBeforeRelease: press.pipelineRedrawsSinceDown, pipelineRedrawsBeforeDown: press.pipelineRedrawsBeforeDown };
          globalThis.__pipelinePressDiagnostic.refresh = observation;
          return JSON.stringify(observation);
        })()`));
        assert.equal(refreshObservation.fetchedNewItem, true, `the real API refresh received the new native board item: ${JSON.stringify(refreshObservation)}`);
        assert.equal(refreshObservation.originalCardConnectedWhileHeld, true, `the changed board does not replace the pressed card before mouseup: ${JSON.stringify(refreshObservation)}`);
        assert.equal(refreshObservation.pipelineRedrawsBeforeRelease, 0, `the Pipeline has not redrawn while the pointer is held: ${JSON.stringify(refreshObservation)}`);
      },
    });
    const evidence = JSON.parse(await chrome.stable('JSON.stringify(globalThis.__pipelinePressDiagnostic.snapshot())'));
    assert.equal(evidence.down?.dataItem, '2', `mousedown reached the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.up?.dataItem, '2', `mouseup reached the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.dataItem, '2', `the browser dispatched click to the intended item: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.down?.connectedAtUp, true, `the original card remained connected through mouseup: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.click?.sameNodeAsDown, true, `the click belongs to the card that received mousedown: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.viewItem, 2, `the native click opens item #2: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pathname, '/items/2', `the item address agrees with the real selection: ${JSON.stringify(evidence)}`);
    assert.equal(evidence.pipelineRedrawsBetweenDownAndUp, 0, `no Pipeline redraw separates mousedown and mouseup: ${JSON.stringify(evidence)}`);
    await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('#2')");
    await chrome.stable('refresh()');
    assert.equal(await chrome.stable('view.item'), 2, 'refresh preserves the selected item instead of an address candidate');
    await chrome.send('Page.reload', {});
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/2' && view.item === 2");
    assert.equal(await chrome.stable('view.item'), 2, 'reload restores the selected item from its address');
    t.diagnostic(`375px 6× held-pointer API refresh: ${JSON.stringify({ refreshObservation, evidence })}`);
    assert.deepEqual(chrome.exceptions, [], 'the refresh and held-pointer click produce no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
