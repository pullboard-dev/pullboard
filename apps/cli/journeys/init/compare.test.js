// pullboard: browser
/** @pullboard-test-gui */
/** A private native event import seeds two windows; this fixture is not review assurance [N26,R1,R2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { NEXT_IDLE_ENGINE } from '../../../../packages/state/light.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

/** Import ordered native event-shaped fixture records, leaving mutable items visibly open. */
function seedWindows(box, demo) {
  const base = Date.now() - 240 * 60_000;
  /** Fixed event gaps leave every transition inside its intended two-hour window. */
  const at = minute => new Date(base + minute * 60_000).toISOString();
  let document;
  const file = join(demo.repo, '.git/pullboard/board.sqlite');
  // @pullboard-board-file journey: the native export/import seeds the persisted board served over authenticated HTTP.
  const board = openBoard(file);
  try {
    const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'window-reviewer'), parentDigest: 'b'.repeat(64) });
    document = exportBoard(board);
    const head = box.git(demo.repo, 'rev-parse', 'HEAD');
    const rows = [
      [0,'web-1','join',null,{lane:'web'}], [0,reviewer,'join',null,{lane:'review'}],
      [2,'coordinator','add',1,{lane:'web'}], [2,'coordinator','add',3,{lane:'web'}],
      [4,'web-1','claim',1,{leaseUntil:at(300)}], [4,'web-1','claim',3,{leaseUntil:at(300)}],
      [10,'web-1','submit',3,{commit:head}], [20,'web-1','submit',1,{commit:head}],
      [22,'web-1','next-idle',null,{version:1,engine:NEXT_IDLE_ENGINE,reason:'held'}],
      [30,reviewer,'reserve',3,{until:at(300)}], [40,reviewer,'reject',3,{commit:head}],
      [50,reviewer,'reserve',1,{until:at(300)}], [60,'web-1','claim',3,{leaseUntil:at(300)}],
      [70,reviewer,'accept',1,{commit:head}], [80,'web-1','submit',3,{commit:head}],
      [90,reviewer,'reserve',3,{until:at(300)}], [100,reviewer,'accept',3,{commit:head}],
      [110,'coordinator','merged',3,{}], [115,'coordinator','merged',1,{}],
      [130,'coordinator','add',2,{lane:'web'}], [140,'web-1','claim',2,{leaseUntil:at(300)}],
      [160,'web-1','submit',2,{commit:head}],
      [165,'web-1','next-idle',null,{version:1,engine:NEXT_IDLE_ENGINE,reason:'nothing-eligible'}],
      [180,reviewer,'reserve',2,{until:at(300)}], [200,reviewer,'accept',2,{commit:head}],
      [220,'coordinator','merged',2,{}],
    ];
    document.tables.event = rows.map(([minute,by,kind,id,detail],index) => ({event_id:index+1,event_at:at(minute),event_by:by,event_kind:kind,item_id:id,event_detail:JSON.stringify(detail)}));
    document.tables.sqlite_sequence.find(row => row.name === 'event').seq = rows.length;
  } finally { store.closeBoard(board); }
  // Preserve the original private fixture board; native import requires an empty destination.
  assert.ok(demo.repo.startsWith(box.dir + '/'), 'only this test machine owns the restored board');
  renameSync(file, join(demo.repo, '.git/pullboard/window-original.sqlite'));
  // @pullboard-board-file journey: the authenticated view reopens this empty destination after a native import.
  const restored = openBoard(file);
  try { importBoard(restored, document); } finally { store.closeBoard(restored); }
}

test('window overview renders canonical seeded values, directions, shares and minute clocks in Chrome [N26,R1,R2]', { timeout:120_000 }, async () => { // budget: real private board, HTTP state/history and two Chrome viewport sizes.
  const box=machine(), demo=project(box,'window-comparison');
  for (const title of ['Earlier one','Current one','Earlier rework']) box.run(demo.repo,'add','web',title,'--specs','G1','--criterion','Represent this native window fixture.');
  seedWindows(box,demo);
  const server=await startView(box);
  let chrome;
  try {
    const executable=chromeExecutable(); assert.ok(executable,'real Chrome is required');
    chrome=await openSnapshotChrome(executable,'about:blank',join(box.dir,'window-chrome'));
    await chrome.send('Emulation.setTimezoneOverride',{timezoneId:'America/Chicago'});
    await chrome.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await chrome.send('Page.navigate',{url:server.link.href});
    await chrome.waitFor('!!data?.project && !!document.querySelector("[data-tab=activity]")');
    // 648b26dc00 (activity matches the approved mockup) removed the Activity comparison section, so the page's own read is the evidence now.
    await chrome.waitFor('data.project.statsComparison?.available === true');
    const result=JSON.parse(await chrome.stable('JSON.stringify((() => { const c=data.project.statsComparison; return { landed:[c.current.landed,c.previous.landed], reject:[c.current.rejectRate,c.previous.rejectRate], minutes:c.durationMinutes }; })())'));
    assert.deepEqual(result.landed,[1,2]);
    assert.deepEqual(result.reject,[0,1/3]);
    assert.equal(result.minutes,120);
    assert.equal(await chrome.stable('document.querySelector("#activity-compare") === null'),true,'the Activity tab no longer draws a separate comparison section');
    for (const width of [1440,375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await chrome.waitFor('innerWidth === '+width);
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'),true,'the page fits at '+width);
    }
  } finally {if(chrome) await closeSnapshotChrome(chrome); await server.stop();}
});
