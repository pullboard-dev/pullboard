// pullboard: browser
/** @pullboard-test-gui */
/** Doctrine sources, check wording and person-review states are visible in real Chrome [D1,N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardOf } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';

test('Doctrine redesign shows its sources, checks, review state and detail in real Chrome [D1,N26]', { timeout: 120_000 }, async () => {
  const box = machine();
  const repo = project(box, 'doctrine-redesign', undefined, { practice: 'DOCTRINE.md' });
  mkdirSync(join(repo.repo, 'test'));
  writeFileSync(join(repo.repo, 'test/proof.test.js'), 'export const proof = true;\n');
  writeFileSync(join(repo.repo, 'DOCTRINE.md'), '# Team doctrine\n\n## Local\n'
    + '- R1 [draft, must] Keep the real file gate visible. | gate: test/proof.test.js\n'
    + '- R2 [approved, aim] Readable check names fit the row. | gate: the project\'s gate\n'
    + '- G1 [approved, must] A local doctrine row keeps its item citation. | gate: commit-msg hook, review\n');
  box.git(repo.repo, 'add', '-A');
  box.git(repo.repo, 'commit', '-qm', 'test: seed real Doctrine gate evidence');
  await box.inProcess(repo.repo, 'add', 'web', 'Doctrine citation', '--specs', 'G1', '--criterion', 'The doctrine row has an item citation.');
  const server = await startView(box);
  let chrome;
  try {
    const state = await boardOf(server, repo.repo);
    assert.equal(state.practice.find(row => row.id === 'R1').gateFiles[0].exists, true);
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required by the frozen Doctrine redesign journey');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'doctrine-redesign-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.navigate', { url: server.link.href });
    await chrome.waitFor('document.querySelector("[data-tab=doctrine]") && !document.body.classList.contains("loading")');
    await press(chrome, 'document.querySelector("[data-tab=doctrine]")');
    await press(chrome, 'document.querySelector("#doctrine-chips [data-rows=\\"doctrine:all\\"]")');
    await chrome.waitFor('document.querySelectorAll("#doctrine-list [data-row]").length === 15');

    const list = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const row = id => document.querySelector('#doctrine-list [data-row="doctrine:' + id + '"]');
      const pb1 = row('PB1'), pb6 = row('PB6'), pb7 = row('PB7'), pb9 = row('PB9'), local = row('R1');
      const section = document.querySelector('#doctrine-list .spec-section-head');
      return { sources: [pb1.querySelector('.rule-source-chip').textContent, local.querySelector('.rule-source-chip').textContent],
        sourceTitle: pb1.querySelector('.rule-source-chip').title,
        checks: [pb1.querySelector('.doctrine-check').textContent, pb6.querySelector('.doctrine-check').textContent,
          pb9.querySelector('.doctrine-check').textContent],
        gateFile: local.querySelector('.spec-gate')?.textContent,
        pendingText: pb7.textContent, pendingChip: pb7.querySelector('.chip')?.textContent,
        pendingColor: getComputedStyle(pb7.querySelector('.chip')).color, pendingDotColor: getComputedStyle(pb7.querySelector('.dot')).color,
        bodyColor: getComputedStyle(document.body).color, pendingState: pb7.querySelector('.dot').className,
        pendingIcon: !!pb7.querySelector('.doctrine-eye'), pendingRed: !!pb7.querySelector('.chip.no'),
        filter: document.querySelector('#doctrine-chips [data-rows="doctrine:defaults"]')?.textContent,
        section: section?.querySelector('h4')?.innerText, sectionCount: section?.querySelector('.section-count')?.textContent,
        reviewCount: section?.querySelector('.doctrine-review-count')?.textContent,
        approveAll: !!section?.querySelector('button') };
    })())`));
    assert.deepEqual(list.sources, ['Standard', 'This repo']);
    assert.match(list.sourceTitle, /^Pullboard v\d+$/);
    assert.deepEqual(list.checks, ['Checked in review', "The project's gate", 'Commit hook + review']);
    assert.match(list.gateFile, /test\/proof\.test\.js/);
    assert.match(list.pendingText, /To review/u);
    assert.equal(list.pendingChip, 'To review');
    assert.equal(list.pendingState, 'dot warn');
    assert.notEqual(list.pendingDotColor, list.bodyColor, 'the review eye uses the amber warning color');
    assert.equal(list.pendingIcon, true);
    assert.equal(list.pendingRed, false);
    assert.match(list.filter, /^To review12$/u);
    assert.match(list.section, /^PB · Pullboard rules/u);
    assert.equal(list.sectionCount, '12');
    assert.equal(list.reviewCount, '1 to review');
    assert.equal(list.approveAll, false, 'standard rows have no decision or bulk controls');

    await press(chrome, 'document.querySelector("#doctrine-list [data-row=\\"doctrine:PB7\\"]")');
    const standard = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const detail = document.querySelector('#doctrine-detail');
      return { text: detail.textContent, source: detail.querySelector('.rule-source-chip')?.textContent,
        status: detail.querySelector('.meta .chip')?.textContent,
        checked: detail.querySelector('.spec-fact')?.textContent,
        actions: [...detail.querySelectorAll('.spec-detail-actions button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })),
        sectionLabel: detail.querySelector('.spec-detail-section')?.textContent,
        sectionTransform: getComputedStyle(detail.querySelector('.spec-detail-section')).textTransform };
    })())`));
    assert.equal(standard.source, 'Standard');
    assert.equal(standard.status, 'To review');
    assert.equal(standard.checked, 'Checked byChecked in review');
    assert.equal(standard.sectionLabel, 'Rules');
    assert.equal(standard.sectionTransform, 'uppercase');
    assert.match(standard.text, /Standard rules come with Pullboard as defaults to review\. Approve it to keep it, or override or decline it in DOCTRINE\.md\./u);
    assert.deepEqual(standard.actions, [], 'standard decisions remain unwired until the native action path lands');

    await press(chrome, 'document.querySelector("#doctrine-list [data-row=\\"doctrine:R1\\"]")');
    const local = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const detail = document.querySelector('#doctrine-detail');
      return { source: detail.querySelector('.rule-source-chip')?.textContent,
        checked: detail.querySelector('.spec-fact')?.textContent,
        gateOpen: detail.querySelector('.spec-fact .spec-gate button')?.textContent,
        buttons: [...detail.querySelectorAll('.spec-detail-actions button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })),
      };
    })())`));
    assert.equal(local.source, 'This repo');
    assert.match(local.checked, /test\/proof\.test\.js/);
    assert.equal(local.gateOpen, 'Open');
    assert.deepEqual(local.buttons.map(button => button.text), ['Approve A', 'Decline D']);
    assert.ok(local.buttons.every(button => !button.disabled), 'local proposal decisions remain enabled');
    await press(chrome, 'document.querySelector("#doctrine-detail .spec-fact button[data-code]")');
    await chrome.waitFor('document.querySelector("#doctrine-detail .code-wrap")');
    assert.match(await chrome.stable('document.querySelector("#doctrine-detail .code-wrap").textContent'), /export const proof = true/u);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
  }
});
