// pullboard: browser
/** @pullboard-test-gui */
/** The approved Spec and Doctrine explanations stay directly below each row toggle on desktop and phone [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';

test('Spec and Doctrine descriptions stay under their row toggles on desktop and phone [N26]', { timeout: 120_000 }, async () => {
  const box = machine();
  const demo = project(box, 'rule-tab-descriptions', undefined, { practice: 'DOCTRINE.md' });
  mkdirSync(join(demo.repo, 'docs'));
  writeFileSync(join(demo.repo, 'DOCTRINE.md'), '# Team rules\n\n## Local\n- R1 [approved, must] Keep each tab clear. | gate: test/clear.test.js\n');
  writeFileSync(join(demo.repo, 'docs', 'clear.test.js'), 'export const clear = true;\n');
  box.git(demo.repo, 'add', '-A');
  box.git(demo.repo, 'commit', '-qm', 'docs: seed a local Doctrine rule');
  const server = await startView(box);
  let chrome;
  try {
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required for the frozen description journey');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'rule-tab-descriptions-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Page.navigate', { url: server.link.href });
    await chrome.waitFor('document.querySelector("[data-tab=spec]") && !document.body.classList.contains("loading")');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      for (const [kind, expected] of [
        ['spec', 'What to build: the requirements you approve.'],
        ['doctrine', "How it's built: the rules every agent follows."],
      ]) {
        await chrome.click(`document.querySelector('[data-tab="${kind}"]')`);
        await chrome.waitFor(`!document.querySelector('[data-pane="${kind}"]').hidden && !!document.querySelector('#${kind}-description')`);
        const layout = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const toggle = document.querySelector('#${kind}-chips [data-segmented-control]');
          const description = document.querySelector('#${kind}-description');
          const toggleBox = toggle.getBoundingClientRect(), descriptionBox = description.getBoundingClientRect();
          return { text: description.textContent, under: descriptionBox.top >= toggleBox.bottom,
            viewport: document.documentElement.scrollWidth <= innerWidth };
        })())`));
        assert.equal(layout.text, expected, `${width}px: ${kind} shows the approved exact description`);
        assert.equal(layout.under, true, `${width}px: ${kind} description sits below its row toggle`);
        assert.equal(layout.viewport, true, `${width}px: ${kind} keeps the page within the viewport`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'the rule panes have no uncaught browser errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
  }
});
