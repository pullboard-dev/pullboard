// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css */
/** Shared rows preserve accepted variants and provide native in-place expansion [N26]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sharedRowHtml } from '../../../view/index.js';
import {
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

test('shared row variants retain their layout and the default row expands in place in Chrome [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the component geometry and native disclosure need real Chrome');
  const needs = sharedRowHtml({ variant: 'needs', id: '#27', title: 'A question for the person', meta: 'Asked by view-213',
    state: 'question', iconHtml: '?', time: '9:12 PM', chip: 'Review', attributes: { id: 'needs-row' } });
  const activity = sharedRowHtml({ variant: 'activity', state: 'build', time: '9:12 PM', iconHtml: '↗',
    mainHtml: '<p>view-213 started building</p><span class="activity-item">#27 A question for the person</span>', attributes: { id: 'activity-row' } });
  const item = sharedRowHtml({ id: '#27', title: 'A long item title that must stay on one line '.repeat(10), meta: 'view · N26',
    time: '9:12 PM', chip: 'view-213', state: 'open', attributes: { id: 'item-row', 'data-item': 27 },
    detailHtml: '<p id="expanded-content">The item expands here.</p>' });
  const css = readFileSync(new URL("../../../view/src/io/main.css", import.meta.url), 'utf8').replace('/* @pullboard-items-row-styles */', readFileSync(new URL("../../../view/src/io/item/rows.css", import.meta.url), 'utf8'));
  const html = '<!doctype html><meta charset="utf-8"><style>' + css + '\n#component-rows{width:min(32rem,90vw);list-style:none}</style>'
    + '<ol id="component-rows">' + needs + activity + item + '</ol>';
  const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(html));
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-row-component-'));
  let chrome;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    chrome = await openSnapshotChrome(executable, 'http://127.0.0.1:' + server.address().port, join(directory, 'chrome'));
    await chrome.waitFor("!!document.querySelector('#item-row .dot')");
    const layout = await chrome.stable(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height }; };
      const title = document.querySelector('#item-row .t');
      return { activityTime:rect('#activity-row time'), activityCircle:rect('#activity-row .activity-verb'),
        needsAge:rect('#needs-row .needs-age'), needsAction:rect('#needs-row .needs-action'),
        itemCircle:rect('#item-row .dot'), itemTime:rect('#item-row .row-age'), itemChip:rect('#item-row > .row-side > .chip'),
        title:rect('#item-row .t'), clips:title.scrollWidth > title.clientWidth, ellipsis:getComputedStyle(title).textOverflow };
    })()`);
    assert.equal(layout.activityCircle.width, 22, 'Activity retains its accepted circle size');
    assert.ok(layout.activityTime.right <= layout.activityCircle.x, 'Activity retains time on the left');
    assert.ok(layout.needsAge.right <= layout.needsAction.x, 'Needs retains horizontal age and action');
    assert.ok(Math.abs(layout.needsAge.y - layout.needsAction.y) < 8, 'Needs does not stack the age over its action');
    assert.equal(layout.itemCircle.width, 20);
    assert.equal(layout.itemCircle.height, 20);
    assert.ok(layout.itemCircle.right <= layout.title.x, 'the default state circle is left of its title');
    assert.ok(layout.itemTime.bottom <= layout.itemChip.y + 2, 'the default time is above its chip');
    assert.ok(Math.abs(layout.itemTime.right - layout.itemChip.right) < 1, 'the right column aligns both lines');
    assert.equal(layout.clips, true);
    assert.equal(layout.ellipsis, 'ellipsis');
    await chrome.click("document.querySelector('#item-row')");
    await chrome.waitFor("document.querySelector('#item-row').parentElement.open && document.querySelector('#expanded-content').getBoundingClientRect().height > 0");
    await chrome.stable("document.querySelector('#item-row').focus()");
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await chrome.waitFor("!document.querySelector('#item-row').parentElement.open");
    assert.deepEqual(chrome.exceptions, [], 'row rendering and expansion produce no browser exception');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
  }
});
