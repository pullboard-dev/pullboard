// pullboard: browser
/** @pullboard-test-gui */
/** Native Spec provenance, real gate files and Chrome layout/actions share one board [N26,B26,B23]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

test('Spec keeps state, tier, gate evidence and person decisions distinct in real Chrome [N26,B26,B23]', { timeout: 120_000 }, async () => { // budget: native Git/API fixtures and real Chrome at desktop and phone widths.
  const box = machine();
  const spec = '# Spec layout\n\n## G · Board\n- G1 [draft, must] Keep the complete first requirement in the detail. | gate: test/proof.test.js\n- G2 [approved, aim] Keep tier visible for an approved row. | gate: test/proof.test.js\n\n## H · Gates\n- G3 [draft, aim] Disclose missing proof files. | gate: test/missing.test.js\n';
  const demo = project(box, 'spec-redesign', spec, {}, { agentApproved: true });
  mkdirSync(join(demo.repo, 'test'));
  writeFileSync(join(demo.repo, 'test/proof.test.js'), '// Genuine committed gate fixture for the Spec code preview.\n');
  box.git(demo.repo, 'add', '-A');
  box.git(demo.repo, 'commit', '-qm', 'test: commit the actual Spec gate');
  box.run(demo.repo, 'add', 'web', 'Citing native item', '--specs', 'G1', '--criterion', 'Show the native citation in Spec.');
  const server = await startView(box);
  let chrome;
  try {
    const before = await boardOf(server, demo.repo);
    assert.equal(before.spec.find(row => row.id === 'G1').gateFiles[0].exists, true);
    assert.equal(before.spec.find(row => row.id === 'G3').gateFiles[0].exists, false);
    assert.deepEqual(before.needs.filter(row => row.kind === 'agent-approved').map(row => row.id), ['G2']);
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'spec-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.navigate', { url: server.link.href });
    await chrome.waitFor('document.querySelector("[data-tab=spec]") && !document.body.classList.contains("loading")');
    await chrome.click('document.querySelector("[data-tab=spec]")');
    await chrome.waitFor('document.querySelectorAll("#spec-list [data-row]").length === 3');
    const anatomy = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const list = document.querySelector('#spec-list');
      const draft = list.querySelector('[data-row="spec:G1"]');
      const approved = list.querySelector('[data-row="spec:G2"]');
      const missing = list.querySelector('[data-row="spec:G3"] .spec-gate');
      const choice = document.querySelector('[data-rows="spec:decide"]');
      const side = document.querySelector('[data-tab=spec]');
      return { draftIcon: draft.querySelector('.dot').textContent, approvedIcon: approved.querySelector('.dot').textContent,
        tier: approved.querySelector('.spec-row-side .chip').textContent, citations: draft.querySelector('.spec-row-side small').textContent,
        oneLine: getComputedStyle(draft.querySelector('.t')).whiteSpace, gateChip: !!draft.querySelector('.spec-gate.chip'),
        missing: missing.textContent, missingRed: getComputedStyle(missing).color !== getComputedStyle(draft.querySelector('.spec-gate')).color,
        headingSize: getComputedStyle(list.querySelector('h4')).fontSize, sections: list.querySelectorAll('.spec-section-head').length,
        choice: choice.textContent, title: choice.title, sideTitle: side.title, sideCount: side.textContent };
    })())`));
    assert.equal(anatomy.draftIcon, '✎');
    assert.equal(anatomy.approvedIcon, '✓');
    assert.equal(anatomy.tier, 'aim');
    assert.equal(anatomy.citations, '1 item');
    assert.equal(anatomy.oneLine, 'nowrap');
    assert.equal(anatomy.gateChip, false);
    assert.match(anatomy.missing, /test\/missing.test.js · missing/u);
    assert.equal(anatomy.missingRed, true);
    assert.equal(anatomy.headingSize, '13.5px');
    assert.equal(anatomy.sections, 2);
    assert.match(anatomy.choice, /Needs your decision3/u);
    assert.equal(anatomy.title, '2 drafts · 1 approved in Git');
    assert.equal(anatomy.sideTitle, anatomy.title);
    assert.match(anatomy.sideCount, /3/u);
    await chrome.click('document.querySelector("[data-section-approve]")');
    await chrome.waitFor('!document.querySelector("#spec-approve-dialog").hidden');
    assert.equal(await chrome.stable('document.querySelector("#spec-approve-rows").textContent'), 'Rows: G1, G2');
    await chrome.click('document.querySelector("#spec-approve-cancel")');
    await chrome.click(`document.querySelector('[data-row="spec:G1"]')`);
    const detail = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const node = document.querySelector('#spec-detail');
      return { text: node.textContent, sections: node.querySelectorAll('.spec-detail-section').length,
        size: getComputedStyle(node.querySelector('h2')).fontSize,
        buttons: [...node.querySelectorAll('.spec-detail-actions button')].map(button => button.textContent.trim()) };
    })())`));
    assert.equal(detail.sections, 1);
    assert.equal(detail.size, '17px');
    assert.match(detail.text, /Proved by/u);
    assert.match(detail.text, /Cited by/u);
    assert.match(detail.text, /#1 Citing native item/u);
    assert.match(detail.text, /Only you can decide a row/u);
    assert.deepEqual(detail.buttons, ['Approve A', 'Change', 'Decline D']);
    await chrome.click('document.querySelector("#spec-detail [data-code]")');
    await chrome.waitFor('document.querySelector("#spec-detail .code-wrap")');
    assert.match(await chrome.stable('document.querySelector("#spec-detail .code-wrap").textContent'), /Genuine committed gate fixture/u);
    await chrome.click('document.querySelector("#spec-detail [data-row-change]")');
    await chrome.waitFor('view.tab === "shouts"');
    assert.match(await chrome.stable('document.querySelector("#shout-text").value'), /Please propose a change to Spec row G1/u);
    await chrome.click('document.querySelector("[data-tab=spec]")');
    await chrome.click(`document.querySelector('[data-row="spec:G3"]')`);
    assert.match(await chrome.stable('document.querySelector("#spec-detail").textContent'), /No items yet/u);
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      assert.equal(await chrome.stable(`getComputedStyle(document.querySelector('[data-rows="spec:decide"]')).whiteSpace`), 'nowrap');
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'), true, 'Spec does not overflow the viewport');
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
  }
});
