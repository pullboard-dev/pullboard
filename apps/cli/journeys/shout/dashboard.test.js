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

test('Dashboard is the first board tab and Home is removed [N26]', () => {
  const page = cockpitPage();
  const tabs = [...page.matchAll(/<button\b[^>]*\bdata-tab="([^"]+)"[^>]*>([^<]+)<\/button>/gu)]
    .filter(([, tab]) => tab !== 'settings');
  assert.equal(tabs[0]?.[1], 'dashboard');
  assert.equal(tabs[0]?.[2], 'Dashboard');
  assert.ok(!tabs.some(([, tab]) => tab === 'home'), 'Home is not a board tab');
  for (const tab of ['items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap']) {
    assert.ok(tabs.some(([, id]) => id === tab), `${tab} remains available`);
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
    await chrome.waitFor('!!document.querySelector("#dashboard [data-dashboard-stat=building]")');
    assert.equal(await chrome.stable('document.querySelector("#dashboard [data-dashboard-stat=building]").dataset.value'),
      String(activeClaims.length), 'the headline and agent work use the same live claims');
    for (const section of ['Needs you', 'Shipping now', 'Landed per hour', 'Agent time', 'Agents', 'Landing now', 'Just landed', 'In review', 'Next up']) {
      assert.equal(await chrome.stable(`!!document.querySelector('#dashboard [aria-label=${JSON.stringify(section)}]')`),
        true, `${section} is rendered`);
    }
    assert.equal(state.statsComparison?.available, true, 'the actual private board supplies the canonical comparison snapshot');
    const comparisonMinutes = 120; // Declared N26 comparison window, not an execution-time budget.
    assert.equal(state.statsComparison.durationMinutes, comparisonMinutes, 'Dashboard compares the last two hours with the two hours before');
    assert.equal(state.statsComparison.current.until, state.observedAt, 'the full API comparison uses its own read clock');
    assert.ok(state.statsComparison.current.agentHours > 0, 'real seeded join and claim events produce observed-seat time');
    await chrome.waitFor('document.querySelectorAll("#dashboard [data-stats-comparison]").length === 17');
    await press(chrome, 'document.querySelector("#dashboard [data-dashboard-disclosure=comparison] summary")');
    const pace = state.milestones[0].summary.pace;
    assert.equal(await chrome.stable('document.querySelector("#dashboard [data-dashboard-stat=pace6]").dataset.value'),
      String(pace.last6h / 6), 'Dashboard reads the Roadmap six-hour pace');
    await chrome.waitFor(`!!document.querySelector('#dashboard svg[aria-label="Items landed per hour, last 24 hours"]')`);
    for (const [scheme, width] of [['light', 1440], ['dark', 1440], ['light', 375], ['dark', 375]]) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const comparisonView = await chrome.stable(`(() => {
        const comparison = data.project.statsComparison;
        const keys = [
          ...['landed','agentHours','agentHoursPerLanding','idleShare','submitsPerItem','rejectRate','shoutsPerLanding'].map(key => [key,null]),
          ...['nothing-eligible','held','review-family','main-red','unknown'].map(key => [key,'idleReasons']),
          ...['build','rework','reviewWait','review','land'].map(key => [key,'stageShares']),
        ];
        return {
          expected:keys.map(([key,group]) => ({ key:group ? group+'.'+key : key,
            current:String(group ? comparison.current[group][key] : comparison.current[key]),
            previous:String(group ? comparison.previous[group][key] : comparison.previous[key]),
            change:String(group ? comparison.change[group][key] : comparison.change[key]) })),
          actual:Array.from(document.querySelectorAll('#dashboard [data-stats-comparison]'), row => ({ key:row.dataset.statsComparison,current:row.dataset.current,previous:row.dataset.previous,change:row.dataset.change })),
          observedAt:data.project.observedAt, until:comparison.current.until,
          shownAsOf:document.querySelector('#dashboard [data-stats-as-of]').dataset.statsAsOf,
          visible:Array.from(document.querySelectorAll('#dashboard [data-stats-comparison]')).every(row => row.getBoundingClientRect().height > 0),
        };
      })()`);
      assert.deepEqual(comparisonView.actual, comparisonView.expected, 'all 17 displayed scalars come unchanged from this rendered canonical API generation');
      assert.equal(comparisonView.until, comparisonView.observedAt, 'the comparison uses this snapshot read time');
      assert.equal(comparisonView.shownAsOf, comparisonView.until, 'the view shows the API observation clock rather than inventing one');
      assert.equal(comparisonView.visible, true, 'all 17 metrics remain visible when the comparison is opened');
      assert.match(await chrome.stable(`document.querySelector('#dashboard .dash-comparison').textContent`), /all observed seat-hours as their denominator/u);
      const fits = await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1');
      const overflow = await chrome.stable(`JSON.stringify([...document.body.querySelectorAll('*')].map(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { tag: element.tagName, id: element.id, class: element.getAttribute('class'), left: rect.left, right: rect.right, width: rect.width, display: style.display };
      }).filter(rect => rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1)).slice(0, 16))`);
      assert.equal(fits, true, `${scheme} at ${width}px has no sideways page scroll; overflow: ${overflow}`);
      assert.equal(await chrome.stable(`Array.from(document.querySelectorAll('#tabs [data-tab]')).every(button => {
        const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1;
      })`), true, 'every retained tab is accessible inside the viewport');
      const title = await chrome.stable(`(() => {
        const element = document.querySelector('#dashboard [aria-label="Shipping now"] .dash-flight .dash-item b');
        const rect = element.getBoundingClientRect(); return { text: element.textContent.trim(), width: rect.width };
      })()`);
      assert.equal(title.text, 'A task in flight', 'the building row retains the actual task title');
      assert.ok(title.width > 24, `${scheme} at ${width}px leaves visible width for the building title: ${JSON.stringify(title)}`);
      const agentLayout = await chrome.stable(`(() => {
        const row = document.querySelector('#dashboard [data-dashboard-agent="web-1"]');
        const name = row.querySelector('b'), split = document.querySelector('#dashboard .dash-split');
        const splitCard = split.closest('section'), box = splitCard.getBoundingClientRect(), style = getComputedStyle(splitCard);
        return { columns: row.querySelectorAll('.dash-agent-number').length, nameWhiteSpace: getComputedStyle(name).whiteSpace,
          nameText: name.textContent, nameHeight: name.getBoundingClientRect().height,
          splitWidth: split.getBoundingClientRect().width, contentWidth: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2 };
      })()`);
      assert.equal(agentLayout.columns, 3, 'each seeded holder has Build, Review and Shouts columns');
      assert.equal(agentLayout.nameWhiteSpace, 'nowrap', 'the seat name occupies one line');
      assert.equal(agentLayout.nameText, 'web-1', 'model text never wraps into the seat name');
      assert.ok(agentLayout.nameHeight < 30, 'the mono agent name stays on one line');
      assert.ok(Math.abs(agentLayout.splitWidth - agentLayout.contentWidth) < 3, 'Agent time spans the full card content width');
      const contentHeight = await chrome.stable('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)');
      const capture = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: Math.ceil(contentHeight), scale: 1 } });
      // Bounded chunks survive the ordinary native log's 64-KiB line ceiling; the proof reader reassembles each image.
      const chunkSize = 32_000, chunks = Math.ceil(capture.data.length / chunkSize);
      for (let index = 0; index < chunks; index++) console.log('# dashboard-image ' + JSON.stringify({ scheme, width, index, chunks, data: capture.data.slice(index * chunkSize, (index + 1) * chunkSize) }));
    }
    assert.equal(await chrome.stable('document.querySelector("#dashboard [aria-label=Agents]").textContent.includes("web-1")'), true, 'the live summary holder appears in Agents');
    // Where the work is: each of the five step cards opens Items filtered to its own step (#6645).
    for (const [step, state] of [['ready', 'ready'], ['building', 'building'], ['review', 'verify'], ['passed', 'passed'], ['landed', 'landed']]) {
      await press(chrome, `document.querySelector('#dashboard [data-dashboard-step="${step}"]')`);
      await chrome.waitFor(`view.tab === "items" && view.state === ${JSON.stringify(state)}`);
      if (step === 'building') assert.match(await chrome.stable('document.querySelector("#chain").textContent'), /A task in flight/u, 'the Building card lists the item being built');
      await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
      await chrome.waitFor('view.tab === "dashboard"');
    }
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
