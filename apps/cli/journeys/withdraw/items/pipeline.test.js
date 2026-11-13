// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (pipeline), using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  machine,
  project,
  startView,
  target,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  settled,
  press,
  travel,
} from '../../../tests/fixtures/cockpit/harness.js';

import { pipelineBoard } from '../../../tests/fixtures/cockpit/pipeline.js';
import { installPipelinePressDiagnostics } from '../../../tests/fixtures/cockpit/pipeline.js';
import { waitForPipelineItem } from '../../../tests/fixtures/cockpit/pipeline.js';

test('Pipeline view shows every stage, status counts, stage ages, detail links and its phone address [N26,N38]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Pipeline view criterion');
  const box = machine(), alpha = project(box, 'pipeline-board');
  const { base, arrivals } = pipelineBoard(box, alpha);
  const status = JSON.parse(await box.inProcess(alpha.repo, 'status', '--json')).stats.items;
  assert.deepEqual(status, { open: 2, claimed: 1, submitted: 1, verified: 2, withdrawn: 0 });
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)} && document.querySelector('#chain [data-item="5"]')`);
    const listRead = "JSON.stringify([...document.querySelectorAll('#chain > li[data-item]')].map(row => ({id:Number(row.dataset.item),title:row.title,meta:row.querySelector('.meta').textContent,tag:row.lastElementChild.textContent})))";
    const listBefore = await chrome.stable(listRead);
    await press(chrome, "document.querySelector('[data-page-ctl=view][data-value=pipeline]')");
    assert.equal(await chrome.stable('location.pathname'), '/items/pipeline', 'Pipeline has its own shareable address');
    await chrome.waitFor("typeof data !== 'undefined' && location.pathname === '/items/pipeline' && !document.querySelector('#pipeline').hidden");
    const expectedCounts = [0, status.open, status.claimed, status.submitted, 1, 0, 1];
    const read = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#pipeline [data-pipeline-stage]')].map(stage => ({ stage:stage.dataset.pipelineStage, label:stage.querySelector('h2').textContent, count:Number(stage.querySelector('[data-stage-count]').textContent), oldest:Number(stage.querySelector('.pipeline-oldest a[data-go]')?.dataset.go.slice('item:'.length) || 0), since:stage.querySelector('.pipeline-oldest time')?.dataset.ago || null, age:stage.querySelector('.pipeline-oldest time')?.textContent || '', ids:[...stage.querySelectorAll('.pipeline-item')].map(item => Number(item.dataset.item)) })))`));
    assert.deepEqual(read.map(stage => stage.label), ['Blocked', 'Ready', 'Building', 'In review', 'Verified', 'Landing', 'Merged']);
    assert.deepEqual(read.map(stage => stage.count), expectedCounts, 'the seven ordered stage columns preserve the native status counts');
    assert.equal(read[4].count + read[6].count, status.verified);
    assert.deepEqual(read.map(stage => stage.ids), [[], [5, 6], [4], [3], [2], [], [1]], 'an accept without a merge remains verified');
    const observedAt = await chrome.stable('Date.now()');
    for (const stage of read) {
      const arrivalKey = { ready: 'open', building: 'claimed', 'in-review': 'submitted', verified: 'accepted' }[stage.stage] || stage.stage;
      if (!stage.ids.length) { assert.equal(stage.oldest, 0, stage.stage + ': empty stage has no oldest item'); continue; }
      const [id, minute] = arrivals[arrivalKey], since = new Date(base + minute * 60_000).toISOString();
      assert.equal(stage.oldest, id, stage.stage + ': oldest item');
      assert.equal(stage.since, since, stage.stage + ': stage arrival survives edit or lease renewal');
      assert.ok(stage.age.length > 0, stage.stage + ': visible elapsed age');
      assert.match(stage.age, /^\d+(m|h)$/, stage.stage + ': a visible elapsed time');
      const elapsed = parseInt(stage.age, 10) * (stage.age.endsWith('h') ? 60 : 1);
      assert.ok(Math.abs(elapsed - (observedAt - Date.parse(since)) / 60_000) <= 1, stage.stage + ': elapsed time matches native fixture arrival'); // budget: one minute is the display's measured-age rounding unit.
    }
    assert.equal(await chrome.stable("document.querySelector('#item-list').hidden"), true);
    await installPipelinePressDiagnostics(chrome);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      for (const scheme of ['light', 'dark']) {
      await chrome.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme',value:scheme}] });
      await chrome.stable('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()');
      assert.equal(await chrome.stable('document.documentElement.dataset.scheme'), scheme);
      for (const id of [1, 2, 3, 4, 5, 6]) {
        const selector = `document.querySelector('#pipeline .pipeline-item[data-item="${id}"]')`;
        await chrome.stable(`globalThis.__pipelinePressDiagnostic.arm(${selector})`);
        await press(chrome, selector);
        await waitForPipelineItem(chrome, id); // budget: hang-only ceiling for the opened Pipeline item; no speed target.
        assert.equal(await chrome.stable('view.item'), id, `${width}: every item opens its detail`);
        await chrome.waitFor(`document.querySelector('#detail h2')?.textContent.includes('#${id}')`);
      }
      const geometry = JSON.parse(await chrome.stable("JSON.stringify({ width:innerWidth, body:document.documentElement.scrollWidth, stages:[...document.querySelectorAll('.pipeline-stage')].map(node => ({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})) })"));
      assert.ok(geometry.body <= width, `${width}: no sideways scroll: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.stages.every(stage => stage.left >= 0 && stage.right <= width), `${width}: the flow fits the screen`);
      if (process.env.PULLBOARD_PIPELINE_SHOTS) {
        mkdirSync(process.env.PULLBOARD_PIPELINE_SHOTS, {recursive:true});
        await chrome.stable('scrollTo(0,0)');
        const shot = await chrome.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
        writeFileSync(join(process.env.PULLBOARD_PIPELINE_SHOTS, `pipeline-${width}-${scheme}.png`), Buffer.from(shot.data,'base64'));
      }
      }
    }
    await box.inProcess(alpha.repo, 'merged', '2', box.git(alpha.repo, 'rev-parse', 'HEAD'));
    await chrome.waitFor("document.querySelector('[data-stage-count=verified]').textContent === '0' && document.querySelector('[data-stage-count=merged]').textContent === '2'");
    assert.equal(await chrome.stable("document.querySelector('#pipeline [data-pipeline-stage=verified] .pipeline-oldest').textContent"), 'No items', 'a recorded merge advances only the verified item and leaves an honest empty stage');
    await press(chrome, "document.querySelector('[data-page-ctl=view][data-value=list]')");
    await chrome.waitFor("!location.hash && !document.querySelector('#item-list').hidden && document.querySelector('#pipeline').hidden");
    // A stage age ticks over a minute while the case runs, so compare the rows without it.
    const unaged = (rows) => rows.replace(/"tag":"\d+m/g, '"tag":"');
    assert.equal(unaged(await chrome.stable(listRead)), unaged(listBefore), 'returning to List preserves its Active rows, metadata and ordering');
    assert.deepEqual(JSON.parse(listBefore).map(row => row.id).sort((a,b)=>a-b), [3,4,5,6]);
    await travel(chrome, -1);
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/6' && !document.querySelector('#pipeline').hidden");
    await chrome.send('Page.reload', {});
    await settled(chrome, "typeof data !== 'undefined' && location.pathname === '/items/6' && data?.project && !document.querySelector('#pipeline').hidden");
    assert.equal(await chrome.stable("document.querySelector('.tab.on').dataset.tab"), 'items', 'the Pipeline address reloads within Items');
    await travel(chrome, 1);
    await settled(chrome, "!location.hash && !document.querySelector('#item-list').hidden");
    assert.deepEqual(chrome.exceptions, [], 'the pipeline has no uncaught page errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
