/** @pullboard-test-gui */
/** Cockpit items checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addItem, closeBoard, completeCheckBaseline } from '../../src/board.js';
import { openBoard } from '../../apps/lib/index.js';
import { tapTarget, SPEC, machine, project, build, sendBack, startView, element, target, openPage, agentEntries, accept, itemRow, boardOf, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, settled, press } from './fixture.js';
import { assertFirstStateDelay } from './stable.js';


test('wait references stay on one line and link to every prerequisite at phone and desktop widths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prerequisite layout checks.');
  const box = machine();
  const demo = project(box, 'waits-demo');
  box.run(demo.repo, 'add', 'web', 'Prerequisite one', '--specs', 'G1', '--criterion', 'finish first');
  box.run(demo.repo, 'add', 'web', 'Prerequisite two', '--specs', 'G1', '--criterion', 'finish second');
  box.run(demo.repo, 'add', 'web', 'Blocked item', '--specs', 'G1', '--criterion', 'wait on both', '--after', '1,2');
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'waits-chrome'));
    /** Pick a visible click target only after scrolling and its hit-test position have settled. */
    const click = async (selector) => {
      await press(chrome, `document.querySelector(${JSON.stringify(selector)})`);
    };
    await chrome.waitFor("typeof data === 'object' && !!data?.project");
    await assertFirstStateDelay(chrome, t);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && document.querySelector('#chain [data-item="3"] .meta .gate')?.getBoundingClientRect().width > 0`);
      await click('#chain [data-item="1"] .t');
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Prerequisite one')");
      const itemIds = await chrome.stable('data.project.items.map(item => item.id + ":" + item.title + ":" + item.blockedBy.join(","))');
      assert.ok(await chrome.stable('!!document.querySelector(\'#chain [data-item="3"]\')'), `${width}: blocked item appears among ${itemIds.join('; ')}`);
      const list = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const gate=document.querySelector('#chain [data-item="3"] .meta .gate');
        const lineHeight=e=>parseFloat(getComputedStyle(e).lineHeight);
        const neighbors=[...gate.parentElement.children].filter(e=>e!==gate).map(lineHeight).filter(Number.isFinite);
        const units=[...gate.querySelectorAll('.wait-unit')];
        return {height:gate.getBoundingClientRect().height,neighborHeight:Math.max(...neighbors),unitWhiteSpaces:units.map(unit=>getComputedStyle(unit).whiteSpace),unitY:units.map(unit=>unit.getBoundingClientRect().y),links:[...gate.querySelectorAll('a.ref[data-go]')].map(link=>link.dataset.go)};
      })())`));
      t.diagnostic(`${width}px list wait marker: ${list.height}px tall, neighboring metadata line ${list.neighborHeight}px`);
      assert.ok(list.height <= list.neighborHeight + 1, `${width}: list reference matches neighboring metadata height: ${JSON.stringify(list)}`);
      assert.deepEqual(list.unitWhiteSpaces, ['nowrap', 'nowrap'], `${width}: each list prerequisite stays intact`);
      assert.equal(new Set(list.unitY).size, 1, `${width}: both list prerequisites fit on one line: ${JSON.stringify(list)}`);
      assert.deepEqual(list.links, ['item:1', 'item:2'], `${width}: every prerequisite is a link`);

      await click('#chain [data-item="3"] .t');
      await chrome.waitFor("!!document.querySelector('#detail .kv dd.waits-on')");
      const detail = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const waits=document.querySelector('#detail .kv dd.waits-on');
        const units=[...waits.querySelectorAll('.wait-unit')];
        return {height:waits.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(waits).lineHeight),unitWhiteSpaces:units.map(unit=>getComputedStyle(unit).whiteSpace),unitY:units.map(unit=>unit.getBoundingClientRect().y),
          links:[...waits.querySelectorAll('a.ref[data-go]')].map(link=>link.dataset.go)};
      })())`));
      t.diagnostic(`${width}px detail wait marker: ${detail.height}px tall, neighboring metadata line ${detail.lineHeight}px`);
      assert.ok(detail.height <= detail.lineHeight + 1, `${width}: detail prerequisite line matches its metadata: ${JSON.stringify(detail)}`);
      assert.deepEqual(detail.unitWhiteSpaces, ['nowrap', 'nowrap'], `${width}: each detail prerequisite stays intact`);
      assert.deepEqual(detail.links, ['item:1', 'item:2'], `${width}: detail links every prerequisite`);
      assert.equal(new Set(detail.unitY).size, 1, `${width}: detail links share one line: ${JSON.stringify(detail)}`);
      t.diagnostic(`${width}px detail wait links share y=${detail.unitY[0]}`);
      for (const [id, title] of [['1', 'Prerequisite one'], ['2', 'Prerequisite two']]) {
        await click('#chain [data-item="3"] .t');
        await chrome.waitFor("!!document.querySelector('#detail .kv dd.waits-on')");
        await click(`#detail .waits-on [data-go="item:${id}"]`);
        await chrome.waitFor(`document.querySelector('#detail h2').textContent.includes(${JSON.stringify(title)})`);
      }
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
