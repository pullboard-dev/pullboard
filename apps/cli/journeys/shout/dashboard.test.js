// pullboard: browser
/** @pullboard-test-gui */
import '../../../view/tests/logic/render/dashboard.test.js';
import '../../../view/tests/io/dashboard/runtime.test.js';
import '../init/clock.test.js';
import '../sentinel/needs/panel.test.js';
import '../../../view/tests/io/dashboard/model.test.js';
/** The approved Dashboard opens a real board and presents its live state [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import { boardOf } from '../../tests/fixtures/cockpit/harness.js';
import { chooseFilter } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { fetchLive } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { pickProject } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';

test('Dashboard is a board page under Insights and Home is removed [N26]', () => {
  const page = cockpitPage();
  const tabs = [...page.matchAll(/<button\b[^>]*\bdata-tab="([^"]+)"/gu)].map(([, tab]) => tab).filter(tab => tab !== 'settings');
  assert.ok(tabs.includes('dashboard'), 'Dashboard is a board page');
  assert.ok(!tabs.includes('home'), 'Home is not a board tab');
  for (const tab of ['items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap']) {
    assert.ok(tabs.includes(tab), `${tab} remains available`);
  }
});

// A private board, Chrome startup and two viewport/theme passes share the existing 90-second journey budget.
test('clause 1: a board opens on Dashboard with API-backed work, shared pace and existing Items navigation [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Dashboard journey.');
  const box = machine();
  const alpha = project(box, 'dashboard-live');
  box.run(alpha.repo, 'add', 'web', 'A task in flight', '--specs', 'G1',
    '--criterion', 'The fixture project remains present.', '--check', 'test -d web/', '--wait');
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.repo, 'milestone', 'add', '0.1.0', '--reason', 'Arrange fixture release', '--items', '1');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-dashboard-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)}`);
    assert.equal(await chrome.stable('view.tab'), 'dashboard', 'opening a board selects Dashboard');
    // A board with no landing opens the first-run Dashboard (0de17112c6); set it aside so the usual stats are measured.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    const state = await boardOf(view, alpha.repo);
    const activeClaims = state.items.filter(item => item.status === 'claimed');
    assert.equal(activeClaims.length, 1, 'the real API contains the seeded live claim');
    await chrome.waitFor('!!document.querySelector("#dashboard .dash-live [data-dashboard-step=build]")');
    assert.equal(await chrome.stable('document.querySelector("#dashboard [aria-label=Now] [data-dashboard-list=building] b").textContent'),
      String(activeClaims.length), 'the Now line and agent work use the same live claims');
    // The approved /live-style order (#6847); the old hero, Rulings card and comparison card are gone from the Dashboard.
    const order = ['How work moved', 'Now', 'Shipping now', 'Pace and agent time', 'Agents', 'In the gate', 'In review', 'Landing', 'Landed · 4 h', 'Your lanes', 'Runners'];
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#dashboard .dash-live > section, #dashboard .dash-queues > section")].map(node => node.getAttribute("aria-label")))')),
      order, 'the Dashboard draws the mockup sections in order');
    assert.equal(await chrome.stable('document.querySelectorAll("#dashboard .dash-hero, #dashboard [aria-label=Rulings], #dashboard .window-comparison").length'), 0, 'removed sections stay removed');
    assert.equal(state.statsComparison?.available, true, 'the actual private board supplies the canonical comparison snapshot');
    const comparisonMinutes = 120; // Declared N26 comparison window, not an execution-time budget.
    assert.equal(state.statsComparison.durationMinutes, comparisonMinutes, 'the API compares the last two hours with the two hours before');
    assert.equal(state.statsComparison.current.until, state.observedAt, 'the full API comparison uses its own read clock');
    assert.ok(state.statsComparison.current.agentHours > 0, 'real seeded join and claim events produce observed-seat time');
    const pace = state.milestones[0].summary.pace;
    assert.equal(await chrome.stable('document.querySelector("#dashboard [data-dashboard-tile=today] b").textContent'),
      (pace.last6h / 6).toFixed(1), 'Dashboard reads the Roadmap six-hour pace');
    await chrome.waitFor(`!!document.querySelector('#dashboard svg[aria-label="Items landed per hour, last 24 hours"]')`);
    for (const [scheme, width] of [['light', 1440], ['dark', 1440], ['light', 375], ['dark', 375]]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const fits = await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1');
      const overflow = await chrome.stable(`JSON.stringify([...document.body.querySelectorAll('*')].map(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { tag: element.tagName, id: element.id, class: element.getAttribute('class'), left: rect.left, right: rect.right, width: rect.width, display: style.display };
      }).filter(rect => rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1)).slice(0, 16))`);
      assert.equal(fits, true, `${scheme} at ${width}px has no sideways page scroll; overflow: ${overflow}`);
      assert.equal(await chrome.stable(`Array.from(document.querySelectorAll('#tabs > [data-tab], #tabs .tab-group-btn')).every(button => {
        const rect = button.getBoundingClientRect(), strip = button.closest('.strip'); return rect.width > 0 && (strip && getComputedStyle(strip).overflowX === 'auto' ? rect.left >= 0 : rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1);
      })`), true, 'every retained tab is on screen, or reachable by sideways scroll');
      const title = await chrome.stable(`(() => {
        const element = document.querySelector('#dashboard [aria-label="Shipping now"] .dash-ifcol .dash-row .dash-t');
        const rect = element.getBoundingClientRect(); return { text: element.textContent.trim(), width: rect.width };
      })()`);
      assert.equal(title.text, 'A task in flight', 'the building row retains the actual task title');
      assert.ok(title.width > 24, `${scheme} at ${width}px leaves visible width for the building title: ${JSON.stringify(title)}`);
      const agentLayout = await chrome.stable(`(() => {
        const row = document.querySelector('#dashboard [data-dashboard-agent="web-1"]'), name = row.querySelector('td.who');
        return { columns: row.querySelectorAll('.dash-num').length, nameWhiteSpace: getComputedStyle(name).whiteSpace, nameText: name.textContent, rowHeight: row.getBoundingClientRect().height };
      })()`);
      assert.equal(agentLayout.columns, 4, 'each seeded holder has Build, Review, Idle and Shouts columns');
      assert.equal(agentLayout.nameWhiteSpace, 'nowrap', 'the seat name occupies one line');
      assert.equal(agentLayout.nameText, 'web-1', 'model text never wraps into the seat name');
      assert.ok(agentLayout.rowHeight < 30, `one agent is one line: ${JSON.stringify(agentLayout)}`);
      const contentHeight = await chrome.stable('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)');
      const capture = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: Math.ceil(contentHeight), scale: 1 } });
      // Bounded chunks survive the ordinary native log's 64-KiB line ceiling; the proof reader reassembles each image.
      const chunkSize = 32_000, chunks = Math.ceil(capture.data.length / chunkSize);
      for (let index = 0; index < chunks; index++) console.log('# dashboard-image ' + JSON.stringify({ scheme, width, index, chunks, data: capture.data.slice(index * chunkSize, (index + 1) * chunkSize) }));
    }
    assert.equal(await chrome.stable('document.querySelector("#dashboard [aria-label=Agents]").textContent.includes("web-1")'), true, 'the live summary holder appears in Agents');
    // clause 2: each flow card, count and lane number opens Items filtered to what it counts (#6847).
    for (const [step, state] of [['build', 'building'], ['gate', 'verify'], ['review', 'verify'], ['land', 'landed']]) {
      await press(chrome, `document.querySelector('#dashboard [data-dashboard-step="${step}"]')`);
      await chrome.waitFor(`view.tab === "items" && view.state === ${JSON.stringify(state)}`);
      if (step === 'build') assert.match(await chrome.stable('document.querySelector("#chain").textContent'), /A task in flight/u, 'the Build card lists the item being built');
      await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
      await chrome.waitFor('view.tab === "dashboard"');
    }
    await press(chrome, 'document.querySelector("#dashboard [aria-label=\'Your lanes\'] [data-dashboard-list=building][data-dashboard-lane=web]")');
    await chrome.waitFor('view.tab === "items" && view.state === "building" && view.lane === "web"');
    await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
    await chrome.waitFor('view.tab === "dashboard"');
    await press(chrome, 'document.querySelector("#dashboard [data-dashboard-list=review]")');
    await chrome.waitFor('view.tab === "items" && view.state === "verify"');
    await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
    await chrome.waitFor('view.tab === "dashboard"');
    // The Agents notch opens the Dashboard's Agents table at its own address; the notch shows at desktop widths.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await press(chrome, 'document.querySelector("#notch [data-peek=agents]")');
    await chrome.waitFor('view.tab === "dashboard" && location.pathname.endsWith("/dashboard/agents") && !!document.querySelector("#dashboard #dashboard-agents")');
    await press(chrome, 'document.querySelector("#dashboard [data-dashboard-list=next]")');
    await chrome.waitFor('view.tab === "items" && view.state === "ready"');
    await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
    await chrome.waitFor('view.tab === "dashboard"');
    box.run(alpha.repo, 'shout', 'person', 'Which release wording should we use?', '--decision');
    await chrome.waitFor(`document.querySelector('#notch [data-notch="rulings"]').textContent === '1'`);
    await press(chrome, 'document.querySelector("[data-tab=items]")');
    await chrome.waitFor('view.tab === "items"');
    assert.equal(await chrome.stable('view.state'), 'ready', 'Items preserves the filter chosen by the Dashboard link');
    await chooseFilter(chrome, 'state:active');
    assert.match(await chrome.stable('document.querySelector("#chain").textContent'), /A task in flight/u);
    for (const path of ['/dashboard', '/dashboard-live/dashboard']) {
      const response = await fetchLive(view.base + path, { headers: { 'x-pullboard-key': view.key } });
      assert.equal(response.status, 200, 'Dashboard addresses serve the board page directly');
    }
    await chrome.send('Page.navigate', { url: view.base + '/dashboard' });
    await chrome.waitFor(`typeof view !== 'undefined' && view.tab === 'dashboard' && data?.project?.root === ${JSON.stringify(alpha.repo)}`);
    await chrome.send('Page.navigate', { url: view.base + '/home' });
    await chrome.waitFor(`view.tab === 'dashboard' && data?.project?.root === ${JSON.stringify(alpha.repo)}`);
    assert.equal(await chrome.stable('location.pathname'), '/dashboard', 'a legacy Home address opens the Dashboard');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
