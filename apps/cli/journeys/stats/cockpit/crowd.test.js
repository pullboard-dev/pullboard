// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit stats checks: crowd [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { tapTarget } from '../../../tests/fixtures/cockpit/harness.js';
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
    await chrome.waitFor("!!data?.project?.proofStats && document.querySelector('#proof-stats-summary') && document.querySelector('#chain > li')");
    const api = JSON.parse(await chrome.stable('JSON.stringify(data.project.proofStats)'));
    assert.equal(api.flow.bottleneck.stage, 'mergeWait', 'the real measured board has an accepted queue bottleneck');
    const expectedSummary = `${api.merged} merged · ${(Number(api.rejectionShare) * 100).toFixed(1)}% sent back`
      + (api.flow?.bottleneck ? ` · Bottleneck: Merge wait${api.flow.bottleneck.recommendation ? ', ' + api.flow.bottleneck.recommendation : ''}` : '');
    const layouts = [];
    for (const scheme of ['light', 'dark']) for (const width of [375, 1280]) {
      const height = width < 900 ? 812 : 800;
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await chrome.waitFor(`innerWidth === ${width} && innerHeight === ${height} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
      const before = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const summary=document.querySelector('#proof-stats-summary'), text=summary.querySelector('.proof-stats-summary-text');
        const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,right:r.right};};
        const lineHeight=parseFloat(getComputedStyle(text).lineHeight);
        const natural=text.cloneNode(true);
        Object.assign(natural.style,{position:'absolute',visibility:'hidden',width:text.getBoundingClientRect().width+'px',webkitLineClamp:'unset'});
        text.parentNode.append(natural);
        const naturalHeight=natural.getBoundingClientRect().height; natural.remove();
        const first=document.querySelector('#chain > li');
        return {summary:text.textContent, summaryLines:Math.ceil(text.getBoundingClientRect().height/lineHeight), summaryClipped:text.scrollHeight > text.clientHeight + 1, naturalHeight, lineHeight, clamp:getComputedStyle(text).webkitLineClamp, summaryBox:rect(summary),
          expanded:summary.getAttribute('aria-expanded'), first:first?.dataset.item ?? null, firstBox:first&&rect(first), itemListHidden:document.querySelector('#item-list').hidden,
          viewportWidth:document.documentElement.clientWidth, pageWidth:document.documentElement.scrollWidth, viewportHeight:innerHeight,
          itemOrder:data.project.items.filter(item => [3,4].includes(item.id)).map(item => ({id:item.id,status:item.status,updatedAt:item.updatedAt,holder:item.holder}))};
      })())`));
      assert.equal(before.summary, expectedSummary, `${width}px ${scheme}: the line selects the API merged, sent-back and bottleneck values`);
      assert.equal(before.expanded, 'false', `${width}px ${scheme}: the compact summary starts closed`);
      assert.equal(before.summaryLines <= (width < 900 ? 2 : 1), true, `${width}px ${scheme}: the summary occupies at most two compact lines: ${JSON.stringify(before.summaryBox)}`);
      assert.equal(before.clamp, width < 900 ? '2' : '1', `${width}px ${scheme}: overflow uses the browser's line-clamp ellipsis`);
      if (before.naturalHeight > before.lineHeight * (width < 900 ? 2 : 1) + 1) assert.equal(before.summaryClipped, true, `${width}px ${scheme}: a recommendation that would exceed the line limit is clipped`);
      assert.ok(before.summaryBox.height >= tapTarget(width), `${width}px ${scheme}: the summary meets the #371 target size`);
      assert.equal(before.itemListHidden, false, `${width}px ${scheme}: the item list remains the visible default`);
      assert.equal(before.first, '4', `${width}px ${scheme}: the first real item row is present: ${JSON.stringify(before.itemOrder)}`);
      assert.ok(before.firstBox.bottom <= height, `${width}px ${scheme}: the first item appears without scrolling: ${JSON.stringify(before)}`);
      assert.ok(before.pageWidth <= before.viewportWidth, `${width}px ${scheme}: no horizontal page overflow`);
      layouts.push({ scheme, width, firstBottom: before.firstBox.bottom, summaryHeight: before.summaryBox.height });

      if (process.env.PULLBOARD_STATS_PROOF) {
        mkdirSync(process.env.PULLBOARD_STATS_PROOF, { recursive: true });
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PULLBOARD_STATS_PROOF, `stats-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      }

      await press(chrome, "document.querySelector('#proof-stats-summary')");
      await chrome.waitFor("!document.querySelector('#proof-stats-full').hidden");
      const card = await chrome.stable("document.querySelector('#proof-stats-full').textContent");
      const details = JSON.parse(await chrome.stable(`JSON.stringify({agentCount:document.querySelector('[data-stat="agentCount"]')?.textContent,
        familyTile:!!document.querySelector('[data-stat="familyCount"]'), hasFirstAgent:document.querySelector('#proof-stats-full').textContent.includes('web-1'),
        hasPrivateName:document.querySelector('#proof-stats-full').textContent.includes('Private model'), hasFamilyName:document.querySelector('#proof-stats-full').textContent.includes('private-family-')})`));
      for (const agent of stats.agents) assert.equal(card.includes(agent.id), false, `${width}px ${scheme}: the card does not name ${agent.id}`);
      for (const family of api.families) assert.equal(card.includes(family.name), false, `${width}px ${scheme}: the card does not name family ${family.name}`);
      assert.equal(await chrome.stable("document.querySelector('[data-flow=bottleneck]').textContent"), api.flow.bottleneck.message, 'the full API message stays unchanged in the expanded card');
      assert.equal(await chrome.stable("document.querySelector('[data-flow=recommendation]').textContent"), api.flow.bottleneck.recommendation, 'the full API recommendation stays unchanged in the expanded card');
      assert.equal(details.agentCount, '300', `${width}px ${scheme}: the expanded card shows the count only`);
      assert.equal(details.familyTile, false, `${width}px ${scheme}: the expanded card has no Families tile`);
      assert.equal(details.hasFirstAgent || details.hasPrivateName || details.hasFamilyName, false, `${width}px ${scheme}: the card does not name agents or families`);
      assert.doesNotMatch(card, /Families:/i, `${width}px ${scheme}: no Families line appears in the card`);

      if (process.env.PULLBOARD_STATS_PROOF) {
        const shot = await chrome.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.PULLBOARD_STATS_PROOF, `stats-card-${width}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      }

      if (width === 375 && scheme === 'light') {
        await press(chrome, "document.querySelector('#proof-stats-summary')");
      } else {
        for (const type of ['keyDown', 'keyUp']) await chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      assert.equal(await chrome.stable("document.querySelector('#proof-stats-full').hidden"), true, `${width}px ${scheme}: the summary or Escape folds the expanded card`);
      assert.equal(await chrome.stable('document.activeElement?.id'), 'proof-stats-summary', `${width}px ${scheme}: closing returns focus to the list summary`);
      await chrome.stable('refresh().then(() => true)');
      assert.equal(await chrome.stable('document.activeElement?.id'), 'proof-stats-summary', `${width}px ${scheme}: a real API refresh preserves the returned keyboard focus`);
      assert.equal(await chrome.stable('document.querySelector("#chain > li")?.dataset.item'), '4', `${width}px ${scheme}: closing returns to the unchanged item list`);
    }
    assert.equal(layouts.length, 4, 'the compact board was checked in both themes at both target widths');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
