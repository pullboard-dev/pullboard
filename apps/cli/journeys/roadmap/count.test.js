// pullboard: browser
/** @pullboard-test-gui */
/** The Roadmap browser title follows real remaining work and native live landings [N26,N38]. */
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
  build,
  accept,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

/** Read the actual release-header totals and unfinished rendered rows beside the browser title. */
const ROADMAP_COUNT = `JSON.stringify({ title: document.title,
  remaining: [...document.querySelectorAll('#roadmap .roadmap-left b')].reduce((sum, node) => sum + Number.parseInt(node.textContent, 10), 0),
  unfinished: [...document.querySelectorAll('#roadmap .milestone-item')].filter(node => !node.querySelector('.roadmap-state.landed')).length })`;

// budget: hang ceiling for one real browser, native fixture setup, and one streamed landing; no speed threshold.
test('Roadmap title counts shown remaining work and follows a real landing without manual refresh [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'this journey requires an admitted Chrome runner');
  const box = machine();
  const demo = project(box, 'roadmap-count');
  for (const title of ['Ready to land', 'Next work', 'Later work', 'Not in a milestone']) {
    box.run(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The page shows the native work.');
  }
  build(box, demo, 1, 'landing.txt');
  accept(box, demo, 1);
  box.run(demo.repo, 'milestone', 'add', 'Next', '--items', '1,2', '--reason', 'Arrange fixture release');
  box.run(demo.repo, 'milestone', 'add', 'Later', '--items', '3', '--reason', 'Arrange fixture release');
  const server = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-count-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, server.link.href, profile);
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("document.querySelectorAll('#roadmap .milestone-item').length === 3");
    assert.deepEqual(JSON.parse(await chrome.stable(ROADMAP_COUNT)), {
      title: '(3 remaining) roadmap-count · Roadmap · Pullboard', remaining: 3, unfinished: 3,
    }, 'accepted waiting-to-land still counts; work outside milestones does not');

    box.git(demo.repo, 'merge', '--no-ff', '--no-edit', demo.itemBranches.get(`${demo.baseBranch}:1`));
    box.run(demo.repo, 'merged', '1', box.git(demo.repo, 'rev-parse', 'HEAD'));
    await chrome.waitFor("document.querySelectorAll('#roadmap .roadmap-state.landed').length === 1");
    assert.deepEqual(JSON.parse(await chrome.stable(ROADMAP_COUNT)), {
      title: '(2 remaining) roadmap-count · Roadmap · Pullboard', remaining: 2, unfinished: 2,
    }, 'the event stream updates both the Roadmap and its browser title');

    await press(chrome, "document.querySelector('[data-status=release]')");
    await chrome.waitFor("document.querySelector('[data-roadmap-all]') && document.querySelectorAll('#roadmap .milestone-item').length === 2");
    assert.deepEqual(JSON.parse(await chrome.stable(ROADMAP_COUNT)), {
      title: '(1 remaining) roadmap-count · Roadmap · Pullboard', remaining: 1, unfinished: 1,
    }, 'the focused release and its title use the same milestone selection');
    await press(chrome, "document.querySelector('[data-roadmap-all]')");
    await chrome.waitFor("document.querySelectorAll('#roadmap .milestone-item').length === 3");
    assert.equal(await chrome.stable('document.title'), '(2 remaining) roadmap-count · Roadmap · Pullboard');
    await press(chrome, "document.querySelector('[data-tab=items]')");
    assert.equal(await chrome.stable('document.title'), 'roadmap-count · Pullboard', 'ordinary tabs retain the existing needs title');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
