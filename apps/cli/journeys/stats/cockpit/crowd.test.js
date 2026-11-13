// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit stats checks: crowd [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { press } from '../../../tests/fixtures/cockpit/harness.js';
import { stageAcceptedQueue } from './fixture.js';
import { stageFlowBoard } from './fixture.js';

/** Exercise the glance layout with 300 real registrations and measured native lifecycle moves. */
// budget: 300 registrations plus four Chrome layouts; derived from the existing 90s browser ceiling with fixture headroom.
test('stats read at a glance on a board with hundreds of agents [N26,V2]', { timeout: 300_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the 300-agent stats layout criterion.');
  const box = machine();
  const alpha = project(box, 'stats-at-a-glance');
  stageFlowBoard(box, alpha, store);
  stageAcceptedQueue(box, alpha, store);
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (let index = 4; index <= 299; index += 1) {
      store.register(board, {
        lane: 'web',
        path: join(box.dir, `private-agent-${index}`),
        family: `private-family-${index % 7}`,
        model: `Private model ${index}`,
      });
    }
  } finally {
    store.closeBoard(board);
  }
  const stats = JSON.parse(box.run(alpha.repo, 'stats', '--json')).stats;
  assert.equal(stats.agentCount, 300, 'the actual board stats count all registered agents');

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-stats-at-a-glance-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("!!data?.project");
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#chain > li')");
    const api = JSON.parse(await chrome.stable('JSON.stringify(data.project.proofStats)'));
    assert.equal(api.flow.bottleneck.stage, 'mergeWait', 'the real measured board has an accepted queue bottleneck');
    assert.equal(api.agentCount, 300, 'the API state counts all 300 registered agents');
    assert.equal(Object.hasOwn(api, 'agents'), false, 'the API state names no agents');
    const layouts = [];
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      const height = width < 900 ? 812 : 800;
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === ${width} && innerHeight === ${height} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      const before = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,right:r.right};};
        const first=document.querySelector('#chain > li');
        return {first:first?.dataset.item ?? null, firstBox:first&&rect(first), itemListHidden:document.querySelector('#item-list').hidden,
          card:!!document.querySelector('#proof-stats'), page:document.body.innerText,
          viewportWidth:document.documentElement.clientWidth, pageWidth:document.documentElement.scrollWidth,
          itemOrder:data.project.items.filter(item => [3,4].includes(item.id)).map(item => ({id:item.id,status:item.status,updatedAt:item.updatedAt,holder:item.holder}))};
      })())`));
      assert.equal(before.card, false, `${width}px ${scheme}: Items draws no stats card above the list (#6727)`);
      assert.equal(before.itemListHidden, false, `${width}px ${scheme}: the item list remains the visible default`);
      assert.equal(before.first, '4', `${width}px ${scheme}: the first real item row is present: ${JSON.stringify(before.itemOrder)}`);
      assert.ok(before.firstBox.bottom <= height, `${width}px ${scheme}: the first item appears without scrolling: ${JSON.stringify(before)}`);
      assert.ok(before.pageWidth <= before.viewportWidth, `${width}px ${scheme}: no horizontal page overflow`);
      assert.equal(before.page.includes('Private model') || before.page.includes('private-family-'), false, `${width}px ${scheme}: the page names no private model or family`);
      layouts.push({ scheme, width, firstBottom: before.firstBox.bottom });
    }
    assert.equal(layouts.length, 4, 'the compact board was checked in both themes at both target widths');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
