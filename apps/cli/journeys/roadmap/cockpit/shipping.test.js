// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: shipping order and named waits, using the shared real-board fixtures [N26]. */
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
  buildLocal,
  startView,
  acceptLocal,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

/**
 * Build, accept and land one item, awaiting each board command in this process rather than launching a Node per call.
 * Why: under pull dispatch every submit and verify waits on the local runner, and a launch per command put this file past its budget [C7].
 */
async function landLocal(box, p, id) {
  await buildLocal(box, p, id, `page-${id}.html`);
  await acceptLocal(box, p, id);
  box.git(p.repo, 'merge', '--no-ff', '--no-edit', p.itemBranches.get(`${p.baseBranch}:${id}`));
  await box.inProcess(p.repo, 'merged', String(id), box.git(p.repo, 'rev-parse', 'HEAD'));
}

test('a milestone lists work to ship first, shipped below, and no withdrawn items [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for shipping-order checks.');
  const box = machine();
  const alpha = project(box, 'shipping-rows');
  for (const title of ['First verified', 'First open', 'Second verified', 'Dropped idea', 'Second open']) {
    await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  }
  for (const id of [1, 3]) await landLocal(box, alpha, id);
  await box.inProcess(alpha.repo, 'withdraw', '4', 'not needed');
  // Placing an item in an open release takes it out of the other open ones (2a3a0f7555), so Shipped ships before Next
  // takes the same items; a shipped release keeps its history.
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Shipped', '--reason', 'Arrange fixture release', '--items', '1,4,3');
  await box.inProcess(alpha.repo, 'milestone', 'ship', 'Shipped');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '3,2,4,1,5');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shipping-rows-chrome-'));
  let chrome;
  /** Read the actual row order and every visible-count consumer, including folded history. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const next = document.querySelector('#roadmap-list > [data-key="m:Next"]');
    const progress = next.querySelector('.roadmap-summary-bar');
    const shipped = document.querySelector('#roadmap .shipped-one[data-key="m:Shipped"]');
    return {
      rows: [...next.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      count: next.querySelector('.roadmap-left [aria-label]').getAttribute('aria-label'),
      progress: [progress.querySelector('[data-summary-segment=landed]').dataset.count, progress.dataset.total],
      index: document.querySelector('#roadmap-panel [data-roadmap-jump="m:Next"] b').textContent,
      status: document.querySelector('[data-status=release]').textContent.replace(/\\s+/g, ' ').trim(),
      // Desktop and phone each render the shipping counts; only the panel shown at this width counts (cead5a98d7).
      openCounts: [...document.querySelectorAll('[data-shipping-stage=waiting] dd')].filter(count => count.getClientRects().length > 0).map(count => count.textContent),
      headerWaiting: next.querySelector('[data-summary-state=waiting] b').textContent,
      shippedCount: shipped.querySelector('.milestone-count').textContent,
      shippedRows: [...shipped.querySelectorAll(':scope > .milestone-body > ul .milestone-item .id')].map(id => id.textContent),
      allIds: [...document.querySelectorAll('#roadmap .milestone-item .id')].map(id => id.textContent),
    };
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 2');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > [data-key=\"m:Next\"]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = await read();
      // Queued work leads in queue order, then other work, then landed items in landing order (36add4ed61, f8e8ce444a).
      assert.deepEqual(seen.rows, ['#2', '#5', '#1', '#3'], `${width}: work to ship leads, and landed items follow in landing order`);
      assert.equal(seen.count, '2/4 landed', `${width}: withdrawn work is absent from the card count`);
      assert.deepEqual(seen.progress, ['2', '4'], `${width}: progress counts only retained items`);
      assert.equal(seen.index, '2/4', `${width}: the release index uses the same count`);
      assert.equal(seen.status, 'Next 2/4', `${width}: the status bar names the same next release and count`);
      assert.deepEqual(seen.openCounts, ['2'], `${width}: the companion panel reads the supplied waiting count`);
      assert.equal(seen.headerWaiting, '2', `${width}: the header includes both waiting items`);
      assert.equal(seen.shippedCount, '2 items', `${width}: folded history excludes withdrawn work from its total`);
      assert.equal(seen.allIds.includes('#4'), false, `${width}: no withdrawn row is rendered, including folded history`);
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await chrome.waitFor("document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head').getAttribute('aria-expanded') === 'true'");
      assert.deepEqual((await read()).shippedRows, ['#1', '#3'], `${width}: verified history remains available below the work to ship`);
      await press(chrome, "document.querySelector('#roadmap .shipped-one[data-key=\"m:Shipped\"] > .milestone-head')");
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=shipped] > .milestone-head')");
    }
    assert.deepEqual(chrome.exceptions, [], 'the shipping roadmap raises no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a roadmap case that times out names the page state and its waiting step [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the roadmap diagnostics need real Chrome');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-wait-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, 'about:blank', profile);
    let failure = null;
    const neverArrives = ['fal', 'se'].join('');
    try { await chrome.waitFor(neverArrives, 1_500); } catch (error) { failure = error; } // budget: hang ceiling for the control's own wait that never arrives; no throughput claim.
    assert.ok(failure, 'a wait that never arrives times out');
    assert.match(failure.message, /waiting for step: false/u, 'the timeout names the step it waited on');
    assert.match(failure.message, /the roadmap showed \{/u, 'a wait that never arrives names the roadmap state it saw');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
  }
});
