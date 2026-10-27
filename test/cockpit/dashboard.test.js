import './dashboard-runtime.test.js';
import './dashboard-clock.test.js';
import './dashboard-model.test.js';
/** @pullboard-test-gui */
/** The approved Dashboard opens a real board and presents its live state [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cockpitPage } from '../../src/cockpit.js';
import {
  boardOf, chromeExecutable, closeSnapshotChrome, machine, openSnapshotChrome,
  pickProject, press, project, startView,
} from './fixture.js';

test('Dashboard is the first board tab without removing the existing destinations [N26]', () => {
  const page = cockpitPage();
  const tabs = [...page.matchAll(/<button\b[^>]*\bdata-tab="([^"]+)"[^>]*>([^<]+)<\/button>/gu)]
    .filter(([, tab]) => tab !== 'settings');
  assert.equal(tabs[0]?.[1], 'dashboard');
  assert.equal(tabs[0]?.[2], 'Dashboard');
  for (const tab of ['items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap']) {
    assert.ok(tabs.some(([, id]) => id === tab), `${tab} remains available`);
  }
});

// A private board, Chrome startup and two viewport/theme passes share the existing 90-second journey budget.
test('a board opens on Dashboard with API-backed work, shared pace and existing Items navigation [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Dashboard journey.');
  const box = machine();
  const alpha = project(box, 'dashboard-live');
  box.run(alpha.repo, 'add', 'web', 'A task in flight', '--specs', 'G1',
    '--criterion', 'The fixture project remains present.', '--check', 'test -f pullboard.json', '--wait');
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.1.0', '--items', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-dashboard-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)}`);
    assert.equal(await chrome.stable('view.tab'), 'dashboard', 'opening a board selects Dashboard');
    const state = await boardOf(view, alpha.repo);
    const activeClaims = state.items.filter(item => item.status === 'claimed');
    assert.equal(activeClaims.length, 1, 'the real API contains the seeded live claim');
    await chrome.waitFor('!!document.querySelector("#dashboard [data-dashboard-stat=building]")');
    assert.equal(await chrome.stable('document.querySelector("#dashboard [data-dashboard-stat=building]").dataset.value'),
      String(activeClaims.length), 'the headline and agent work use the same live claims');
    for (const section of ['Needs you', 'Shipping now', 'Landed per hour', 'Agent time', 'Agents', 'Landing now', 'Just landed', 'In review', 'Next up']) {
      assert.equal(await chrome.stable(`!!document.querySelector('#dashboard [aria-label=${JSON.stringify(section)}]')`),
        true, `${section} is rendered`);
    }
    const pace = state.milestones[0].summary.pace;
    assert.equal(await chrome.stable('document.querySelector("#dashboard [data-dashboard-stat=pace6]").dataset.value'),
      String(pace.last6h / 6), 'Dashboard reads the Roadmap six-hour pace');
    for (const [scheme, width] of [['light', 1280], ['dark', 375]]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const fits = await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1');
      assert.equal(fits, true, `${scheme} at ${width}px has no sideways page scroll`);
    }
    assert.equal(await chrome.stable('document.querySelector("#dashboard [aria-label=Agents]").textContent.includes("web-1")'), true, 'the live summary holder appears in Agents');
    await press(chrome, 'document.querySelector("#dashboard [data-dashboard-list=review]")');
    await chrome.waitFor('view.tab === "items" && view.state === "verify"');
    await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
    await chrome.waitFor('view.tab === "dashboard"');
    await press(chrome, 'document.querySelector("#dashboard [data-dashboard-list=next]")');
    await chrome.waitFor('view.tab === "items" && view.state === "ready"');
    await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
    await chrome.waitFor('view.tab === "dashboard"');
    box.run(alpha.repo, 'shout', 'person', 'Which release wording should we use?', '--decision');
    await chrome.waitFor(`document.querySelector('#dashboard [aria-label="Needs you"]').textContent.includes('Which release wording')`);
    await press(chrome, 'document.querySelector("[data-tab=items]")');
    await chrome.waitFor('view.tab === "items"');
    assert.match(await chrome.stable('document.querySelector("#chain").textContent'), /A task in flight/u);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
