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
    await chrome.waitFor('!!document.querySelector("#dashboard .dash-agt thead") && !!document.querySelector("#dashboard .dash-split")');
    for (const [width, scheme] of [[1280, 'light'], [375, 'dark']]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      const dashboard = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const panel = document.querySelector('#dashboard .dash-ship');
        const heads = [...document.querySelectorAll('#dashboard .dash-agt thead th')].map(cell => cell.textContent.trim());
        const row = document.querySelector('#dashboard [data-dashboard-agent]');
        const waiting = [...panel.querySelectorAll('.dash-ifcol .dash-age')].find(label => label.textContent.includes('waiting for a reviewer'));
        const held = panel.querySelector('.dash-key[data-dashboard-list="held"]');
        const group = document.querySelector('#dashboard .dash-agt tr.grp td');
        const region = document.querySelector('#dashboard').getBoundingClientRect(), main = document.querySelector('main'), mainRect = main.getBoundingClientRect(), mainStyle = getComputedStyle(main);
        return {
          viewport: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          left: region.left - mainRect.left - parseFloat(mainStyle.paddingLeft), right: mainRect.right - parseFloat(mainStyle.paddingRight) - region.right, width: region.width,
          shippingHeading: [...panel.querySelectorAll('h2')].filter(heading => heading.getClientRects().length > 0).map(heading => heading.textContent),
          shippingText: panel.textContent, heads,
          agentDurations: [...row.querySelectorAll('.dash-num')].map(cell => cell.textContent.trim()),
          group: { text: group.textContent.trim(), size: getComputedStyle(group).fontSize, transform: getComputedStyle(group).textTransform },
          waitingText: waiting?.textContent.trim(), waitingRect: waiting?.getBoundingClientRect().toJSON(),
          waitingParentRect: waiting?.parentElement.getBoundingClientRect().toJSON(),
          heldCount: held?.querySelector('b')?.textContent.trim(), heldAlign: held ? getComputedStyle(held).alignItems : null,
        };
      })())`));

      assert.equal(dashboard.documentWidth, dashboard.viewport, `${width}/${scheme}: no horizontal page scroll`);
      // The approved /live-style mockup (#6847) centres the Dashboard in a 1192 px column inside the page edges.
      assert.ok(dashboard.width <= 1192.5 && Math.abs(dashboard.left - dashboard.right) < 1.5 && dashboard.left > -1,
        `${width}/${scheme}: the Dashboard column is centred inside the page and at most 1192 px: ${JSON.stringify(dashboard)}`);
      assert.deepEqual(dashboard.shippingHeading, ['Shipping now', 'In flight'], `${width}/${scheme}: the card heads Shipping now, as in the mockup`);
      assert.ok(dashboard.shippingText.includes('Dashboard walk'), `${width}/${scheme}: the actual release remains visible`);
      assert.deepEqual(dashboard.heads.slice(2), ['Now', 'Build', 'Review', 'Idle', 'Shouts'], `${width}/${scheme}: the table keeps its Now column and its numbers`);
      assert.match(dashboard.heads[1], /→ now$/u, `${width}/${scheme}: the timeline header runs from four hours back to now, as in the mockup`);
      assert.ok(dashboard.agentDurations.includes('0m'), `${width}/${scheme}: zero Build/Review time reads 0m`);
      assert.equal(dashboard.agentDurations.some(value => value === '0.0h'), false, `${width}/${scheme}: zero Build/Review time never reads 0.0h`);
      assert.match(dashboard.group.text, /^Building · /u);
      assert.equal(dashboard.group.size, '10px', `${width}/${scheme}: group label is 10px, as in the mockup`);
      assert.equal(dashboard.group.transform, 'uppercase');
      assert.equal(dashboard.waitingText, 'waiting for a reviewer', `${width}/${scheme}: the reviewer status is complete`);
      assert.ok(dashboard.waitingRect.left >= dashboard.waitingParentRect.left - 1
        && dashboard.waitingRect.right <= dashboard.waitingParentRect.right + 1,
      `${width}/${scheme}: reviewer status stays inside its row: ${JSON.stringify(dashboard)}`);
      assert.equal(dashboard.heldCount, '10', `${width}/${scheme}: key count comes from the ten held items`);
      assert.equal(dashboard.heldAlign, 'center', `${width}/${scheme}: the held key swatch centres on its text, as in the mockup`);
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
