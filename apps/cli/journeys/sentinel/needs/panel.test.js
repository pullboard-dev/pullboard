// pullboard: browser
/** @pullboard-test-gui */
/** The approved shared Needs-you rows use real board calls and person decisions [N26,B26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  boardOf,
  chromeExecutable,
  closeSnapshotChrome,
  machine,
  openSnapshotChrome,
  press,
  project,
  startView,
} from '../../../tests/fixtures/cockpit/harness.js';

test('Needs you shares grouped, expandable rows and exact person confirmation across Items and Dashboard [N26,B26]', { timeout: 120_000 }, async () => { // budget: native board/Git setup, two viewports and a real person confirmation.
  const box = machine();
  const spec = '# Needs review\n\n## G · Goals\n' + Array.from({ length: 4 }, (_, i) => '- G' + (i + 1) + ' [approved, must] The actual approved requirement ' + (i + 1) + ' keeps its full final words. | gate: browser gate ' + (i + 1)).join('\n') + '\n- G5 [draft, should] A draft remains for review. | gate: draft gate\n';
  const alpha = project(box, 'needs-panel', spec, {}, { agentApproved: true });
  box.run(alpha.repo, 'shout', 'person', 'Choose the wording for this release. The full question stays available when expanded.', '--decision');
  box.run(alpha.repo, 'sentinel', 'propose', 'hourly-size', '--check', 'node packages/gate/src/io/file/size.js', '--directory', '.', '--every', 'hourly', '--owner', 'coordinator');
  const view = await startView(box);
  let chrome;
  try {
    const initial = await boardOf(view, alpha.repo);
    const approvals = initial.needs.filter(row => row.kind === 'agent-approved');
    assert.deepEqual(approvals.map(row => row.id), ['G1', 'G2', 'G3', 'G4']);
    assert.ok(chromeExecutable(), 'Chrome is required for the two real presentation surfaces');
    chrome = await openSnapshotChrome(chromeExecutable(), view.link.href, join(box.dir, 'needs-panel-chrome'));
    // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the usual Needs-you card is measured.
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo));
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.waitFor('document.querySelectorAll("#dashboard .needs-call").length === 3');
    /** Preserve actual seeded browser views in bounded native-log chunks for visual review. */
    const capture = async (surface, width) => {
      await chrome.stable('window.scrollTo(0, 0); true');
      const height = await chrome.stable('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)');
      const shot = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(height), scale: 1 } });
      const size = 32_000, chunks = Math.ceil(shot.data.length / size);
      for (let index = 0; index < chunks; index++) console.log('# needs-image ' + JSON.stringify({ surface, width, index, chunks, data: shot.data.slice(index * size, (index + 1) * size) }));
    };
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
      await chrome.waitFor('view.tab === "dashboard"');
      assert.equal(await chrome.stable('document.querySelectorAll("#dashboard .needs-call").length'), 3, 'Dashboard caps the same typed rows at three');
      assert.match(await chrome.stable('document.querySelector("#dashboard .needs-more").textContent'), /3 more and 1 draft rows/u);
      assert.equal(await chrome.stable('document.querySelectorAll("#dashboard details[open]").length'), 0, 'the initial summary rows are collapsed');
      await capture('dashboard', width);
      await press(chrome, 'document.querySelector("#dashboard [data-needs-list]")');
      await chrome.waitFor('view.tab === "items" && view.state === "active"');
      assert.match(await chrome.stable('document.querySelector("#needs").textContent'), /Questions and sentinels · 2/u);
      assert.match(await chrome.stable('document.querySelector("#needs").textContent'), /Rows approved in Git, waiting for you · 4/u);
      assert.equal(await chrome.stable('document.querySelector("#needs [data-needs-confirm]").dataset.needsConfirm'), 'G1 G2 G3 G4', 'Confirm all captures every eligible row, including rows beyond the summary');
      assert.equal(await chrome.stable('document.querySelectorAll("#needs .needs-drafts").length'), 1);
      assert.equal(await chrome.stable('document.querySelectorAll("#needs .needs-age time[data-ago]").length > 0'), true, 'dated calls retain the live time element instead of escaped markup');
      assert.equal(await chrome.stable('document.querySelector("#needs").textContent.includes("<time")'), false, 'trusted age markup is not shown as text');
      const selector = '#needs [data-agent-approved="G1"]';
      await press(chrome, `document.querySelector(${JSON.stringify(selector + ' summary')})`);
      await chrome.waitFor(`document.querySelector(${JSON.stringify(selector + ' details')}).open`);
      const row = initial.spec.find(entry => entry.id === 'G1');
      assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' [data-needs-field=commit] .hash-copy')}).textContent`), row.agentApproval.commit.slice(0, 12));
      assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' [data-needs-field=commit] .hash-copy')}).title`), row.agentApproval.commit);
      assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' .needs-detail p')}).textContent`), row.text, 'expanded text preserves the actual full requirement');
      assert.equal(await chrome.stable(`getComputedStyle(document.querySelector(${JSON.stringify(selector + ' .needs-copy b')})).whiteSpace`), 'nowrap', 'the summary title uses the mockup single line');
      assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(selector)}).textContent.includes('agent-approved;')`), false, 'status prose does not replace the row title');
      await capture('items-expanded', width);
      await press(chrome, `document.querySelector(${JSON.stringify(selector + ' summary')})`);
      assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' details')}).open`), false);
      await chrome.stable('render(); true');
      assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(selector + ' details')}).open`), false, 'a hidden duplicate surface cannot reopen the collapsed row on refresh');
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'the full list fits both viewports');
      assert.equal(await chrome.stable(`getComputedStyle(document.querySelector(${JSON.stringify(selector + ' .needs-detail dl')})).gridTemplateColumns.split(' ').length`), 2, 'expanded metadata retains two columns even on a phone');
    }
    await press(chrome, 'document.querySelector("#needs [data-needs-confirm]")');
    await chrome.waitFor('!document.querySelector("#spec-approve-dialog").hidden');
    assert.equal(await chrome.stable('document.querySelector("#spec-approve-rows").textContent'), 'Rows: G1, G2, G3, G4');
    await press(chrome, 'document.querySelector("#spec-approve-submit")');
    await chrome.waitFor('document.querySelectorAll("#needs [data-agent-approved]").length === 0');
    const after = await boardOf(view, alpha.repo);
    for (const id of ['G1', 'G2', 'G3', 'G4']) assert.equal(after.spec.find(row => row.id === id).decision?.decision, 'approve', 'the real person pipeline confirms exactly the captured row');
    assert.equal(Boolean(after.spec.find(row => row.id === 'G5').decision), false, 'Confirm all leaves draft rows untouched');
    assert.equal(after.sentinelDrafts.length, 1, 'Confirm all never approves a sentinel');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); }
  }
});
