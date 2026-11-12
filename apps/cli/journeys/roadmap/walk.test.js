// pullboard: browser
/** @pullboard-test-gui */
/** The Dashboard follows the approved 29 Oct walk at desktop and phone widths. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  chromeExecutable,
  closeSnapshotChrome,
  machine,
  openSnapshotChrome,
  pickProject,
  press,
  project,
  startView,
  build,
} from '../../tests/fixtures/cockpit/harness.js';

test('clause 1: the Dashboard matches the 29 Oct walk at desktop and phone widths [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Dashboard walk.');
  const box = machine();
  const alpha = project(box, 'dashboard-walk', undefined, {
    lanes: {
      web: { owns: ['web/'], specs: ['G'] },
      ops: { owns: ['ops/'], specs: ['G'] },
    },
  });
  const itemIds = Array.from({ length: 11 }, (_, index) => index + 1);
  for (const id of itemIds) {
    const lane = id === 1 ? 'web' : 'ops';
    box.run(alpha.repo, 'add', lane, `Dashboard walk item ${id}`, '--specs', 'G1', '--route', 'strong',
      '--criterion', 'The Dashboard shows the real board state.', '--check', 'true');
  }
  box.run(alpha.repo, 'add', 'web', 'Dashboard walk active build', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The active builder remains visible.', '--check', 'true');
  build(box, alpha, 1, 'dashboard-walk.txt');
  box.run(alpha.web, 'claim', '12');
  box.run(alpha.repo, 'hold', 'ops', '--reason', 'Waiting for the person');
  box.run(alpha.repo, 'milestone', 'add', 'Dashboard walk', '--reason', 'Arrange fixture release', '--items', itemIds.join(','));
  const summary = JSON.parse(box.run(alpha.repo, 'roadmap', '--json')).milestones
    .find(milestone => milestone.name === 'Dashboard walk')?.summary;
  assert.equal(summary?.held, 10, 'the real roadmap API supplies ten held items for the key alignment check');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-dashboard-walk-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && view.tab === 'dashboard'`);
    // A board with no landing opens the first-run Dashboard (0de17112c6); set it aside so the usual cards are measured.
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.waitFor('!!document.querySelector("#dashboard .dash-agent-axis") && !!document.querySelector("#dashboard .dash-split")');
    for (const [width, scheme] of [[1280, 'light'], [375, 'dark']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      const dashboard = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const panel = document.querySelector('#dashboard .dash-shipping');
        const agentTime = document.querySelector('#dashboard .dash-split');
        const agentCard = agentTime.closest('.dash-card');
        const cardStyle = getComputedStyle(agentCard), cardRect = agentCard.getBoundingClientRect();
        const labels = [...document.querySelectorAll('#dashboard .dash-agent-axis > span:nth-child(2) > span')].map(label => label.textContent.trim());
        const nowColumn = document.querySelector('#dashboard .dash-agent-axis > span:nth-child(3)').textContent.trim();
        const row = document.querySelector('#dashboard [data-dashboard-agent]');
        const waiting = [...panel.querySelectorAll('.dash-flight small')].find(label => label.textContent.includes('waiting for a reviewer'));
        const held = panel.querySelector('[data-summary-state="held"]');
        const group = document.querySelector('#dashboard .dash-agent-group');
        const first = document.querySelector('#dashboard > .dash-card').getBoundingClientRect();
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          dashboardLeft: first.left,
          contentLeft: document.querySelector('main').getBoundingClientRect().left + parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft),
          // Since 0ab202b994 the release card opens with the release's own name (an h2.release-name); any other visible h2 is a widget-name eyebrow.
          visibleShippingHeading: [...panel.querySelectorAll('h2:not(.release-name)')].some(heading => heading.getClientRects().length > 0),
          shippingText: panel.textContent,
          agentSplitWidth: agentTime.getBoundingClientRect().width,
          agentContentWidth: cardRect.width - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight) - 2,
          labels, nowColumn,
          duplicateNow: /now\\s+now/i.test(document.querySelector('#dashboard .dash-agent-axis').textContent),
          agentDurations: [...row.querySelectorAll('.dash-agent-number')].map(cell => cell.textContent.trim()),
          group: { text: group.textContent.trim(), className: group.className, size: getComputedStyle(group).fontSize,
            family: getComputedStyle(group).fontFamily, transform: getComputedStyle(group).textTransform },
          waitingText: waiting?.textContent.trim(), waitingRect: waiting?.getBoundingClientRect().toJSON(),
          waitingParentRect: waiting?.parentElement.getBoundingClientRect().toJSON(),
          heldText: held?.textContent.trim(), heldCount: held?.querySelector('b')?.textContent.trim(),
          heldAlign: held ? getComputedStyle(held).alignItems : null,
          heldDot: held?.querySelector('.roadmap-summary-swatch')?.getBoundingClientRect().toJSON(),
          heldLabel: held?.querySelector('span:last-child')?.getBoundingClientRect().toJSON(),
        };
      })())`));

      assert.equal(dashboard.documentWidth, dashboard.viewport, `${width}/${scheme}: no horizontal page scroll`);
      assert.ok(Math.abs(dashboard.dashboardLeft - dashboard.contentLeft) < 1,
        `${width}/${scheme}: Dashboard cards use the same page edge as Items and Spec: ${JSON.stringify(dashboard)}`);
      assert.equal(dashboard.visibleShippingHeading, false, `${width}/${scheme}: the release content has no widget-name eyebrow`);
      assert.ok(dashboard.shippingText.includes('Dashboard walk'), `${width}/${scheme}: the actual release remains visible`);
      assert.ok(Math.abs(dashboard.agentSplitWidth - dashboard.agentContentWidth) < 3,
        `${width}/${scheme}: the Agent time bar spans its card: ${JSON.stringify(dashboard)}`);
      assert.equal(dashboard.nowColumn, 'Now', `${width}/${scheme}: the table retains its distinct Now column`);
      assert.equal(dashboard.duplicateNow, false, `${width}/${scheme}: the time axis does not repeat the Now heading`);
      assert.equal(dashboard.labels.some(label => /^now$/i.test(label)), false,
        `${width}/${scheme}: the timeline endpoint is distinct from the Now column`);
      assert.ok(dashboard.agentDurations.includes('0m'), `${width}/${scheme}: zero Build/Review time reads 0m`);
      assert.equal(dashboard.agentDurations.some(value => value === '0.0h'), false,
        `${width}/${scheme}: zero Build/Review time never reads 0.0h`);
      assert.match(dashboard.group.text, /^BUILDING · /u);
      assert.ok(dashboard.group.className.split(/\s+/u).includes('label'), `${width}/${scheme}: group names use the shared label style`);
      assert.equal(dashboard.group.size, '11px', `${width}/${scheme}: group label is 11px`);
      assert.match(dashboard.group.family, /monospace|mono/u);
      assert.equal(dashboard.group.transform, 'uppercase');
      assert.equal(dashboard.waitingText, 'waiting for a reviewer', `${width}/${scheme}: the reviewer status is complete`);
      assert.ok(dashboard.waitingRect.left >= dashboard.waitingParentRect.left - 1
        && dashboard.waitingRect.right <= dashboard.waitingParentRect.right + 1,
      `${width}/${scheme}: reviewer status wraps inside In review: ${JSON.stringify(dashboard)}`);
      assert.equal(dashboard.heldCount, '10', `${width}/${scheme}: key count comes from the ten held items`);
      assert.equal(dashboard.heldAlign, 'baseline', `${width}/${scheme}: the held key dot aligns on the text baseline`);
      await press(chrome, 'document.querySelector("[data-tab=items]")');
      await chrome.waitFor('view.tab === "items"');
      const itemsLeft = await chrome.stable('document.querySelector("#items-toolbar").getBoundingClientRect().left');
      await press(chrome, 'document.querySelector("[data-tab=spec]")');
      await chrome.waitFor('view.tab === "spec"');
      const specLeft = await chrome.stable('document.querySelector("#spec-list").closest(".card-panel").getBoundingClientRect().left');
      assert.ok(Math.abs(dashboard.dashboardLeft - itemsLeft) < 1, `${width}/${scheme}: Dashboard and Items share the page edge`);
      assert.ok(Math.abs(dashboard.dashboardLeft - specLeft) < 1, `${width}/${scheme}: Dashboard and Spec share the page edge`);
      await press(chrome, 'document.querySelector("[data-tab=dashboard]")');
      await chrome.waitFor('view.tab === "dashboard"');
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
