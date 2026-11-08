// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Native lifecycle rows retain their identities while the approved compact presentation changes [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { machine, project, build, sendBack, accept, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('Items uses compact shared rows with native state icons, plain reasons and whole seat chips [N26]', { timeout: 180_000 }, async () => { // budget: five native lifecycle fixtures and real Chrome at desktop and phone widths.
  const box = machine(), demo = project(box, 'items-rows');
  const longTitle = 'Keep this complete native title available while a narrow row truncates its long visible wording';
  for (let id = 1; id <= 5; id++) box.run(demo.repo, 'add', 'web', longTitle + ' ' + id, '--specs', 'G1', '--criterion', 'Render the actual native row.');
  build(box, demo, 3, 'review.txt');
  build(box, demo, 4, 'back.txt');
  sendBack(box, demo, 4, 'Keep the complete reviewer explanation available when this long sentence is cut off at phone width.');
  build(box, demo, 5, 'verified.txt');
  accept(box, demo, 5);
  const reviewer = JSON.parse(box.run(demo.repo, 'worktree', 'web', '--model', 'A deliberately long reviewer model name', '--json'));
  const submitted = JSON.parse(box.run(demo.repo, 'show', '3', '--json'));
  box.git(reviewer.path, 'switch', '--detach', submitted.item_commit);
  box.run(reviewer.path, 'next', '--verify', '3');
  box.git(demo.web, 'switch', '-q', demo.baseBranch);
  box.run(demo.web, 'claim', '2');
  const server = await startView(box);
  let chrome;
  try {
    const executable = chromeExecutable(); assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'items-rows-chrome'));
    const href = new URL(server.link.href); href.pathname = '/items';
    await chrome.send('Page.navigate', { url: href.href });
    await chrome.waitFor('view.tab === "items" && document.querySelector("#chain [data-item]")');
    await chrome.stable('view.state = "all"; render(); true');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
      await chrome.waitFor('innerWidth === ' + width);
      const rows = JSON.parse(await chrome.stable(`JSON.stringify([1,2,3,4,5].map(id => {
        const row = document.querySelector('#chain [data-item="'+id+'"]'), title = row.querySelector('.t'), dot = row.querySelector('.dot');
        const side = row.querySelector('.row-side'), chip = side?.querySelector('.chip'), time = side?.querySelector('.row-age');
        const rect = node => { const r = node?.getBoundingClientRect(); return r ? {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom} : null; };
        return {id, state:row.className, height:row.getBoundingClientRect().height, title:title.textContent, tooltip:row.title,
          nowrap:getComputedStyle(title).whiteSpace, ellipsis:getComputedStyle(title).textOverflow,
          dot:rect(dot), glyph:dot.querySelector('svg')?.innerHTML ?? '', color:getComputedStyle(dot).color, background:getComputedStyle(dot).backgroundColor,
          chip:chip?.textContent, model:chip?.title, chipBox:rect(chip), timeBox:rect(time), chipOverflow:chip ? chip.scrollWidth > chip.clientWidth : null,
          font:chip ? getComputedStyle(chip).fontFamily : '', meta:row.querySelector('.meta').textContent,
          reasonCode:row.querySelector('.item-reason [title]')?.title, reasonColor:row.querySelector('.item-reason') ? getComputedStyle(row.querySelector('.item-reason')).color : ''};
      }))`));
      assert.equal(rows.length, 5);
      for (const row of rows) {
        assert.equal(row.title, '#' + row.id + longTitle + ' ' + row.id);
        assert.equal(row.tooltip, longTitle + ' ' + row.id);
        assert.equal(row.nowrap, 'nowrap'); assert.equal(row.ellipsis, 'ellipsis');
        assert.equal(row.dot.width, 20); assert.equal(row.dot.height, 20);
        assert.ok(row.height <= 60, width + ': compact row height ' + row.height);
        assert.ok(row.chipBox && row.timeBox, width + ': age above chip');
        assert.ok(row.timeBox.bottom <= row.chipBox.y + 1, 'age is above the chip');
        assert.equal(row.chipOverflow, false, 'the actual seat address is never cut off');
        assert.ok(Math.abs(row.timeBox.right - row.chipBox.right) <= 1, 'right aligned: ' + JSON.stringify({ width, row }));
      }
      assert.equal(rows[0].chip, 'Ready'); assert.equal(rows[4].chip, 'Verified');
      assert.notEqual(rows[0].font, rows[1].font, 'free state is sans, held seat is mono');
      assert.equal(rows[1].chip, 'web-1');
      assert.equal(rows[2].chip, reviewer.agent);
      assert.ok(rows[2].model.startsWith('A deliberately long reviewer model name · In review: '), 'ruling 49037 keeps the model and adds the native stage on hover');
      assert.match(rows[3].meta, /^Behavior did not match Keep the complete reviewer explanation/u);
      assert.equal(rows[3].reasonCode, 'BEHAVIOR_MISMATCH');
      assert.equal(new Set(rows.slice(1).map(row => row.glyph)).size, 4, 'build, review, back and verified use distinct icons');
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'), true, 'no phone overflow');
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await server.stop(); }
});
