// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** A private native event import seeds two windows; this fixture is not review assurance [N26,R1,R2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { openBoard } from '../../apps/lib/index.js';
import { exportBoard, importBoard } from '../../packages/store/index.js';
import { NEXT_IDLE_ENGINE } from '../../src/next-idle-engine.js';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

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
    await chrome.waitFor('document.querySelector("#dashboard .window-comparison") && data.project.statsComparison.available');
    const result=JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const c=data.project.statsComparison, root=document.querySelector('#dashboard .window-comparison');
      const keys=[['landed',false],['rejectRate',true],['idleShare',true],['agentHoursPerLanding',false]];
      return { landed:[c.current.landed,c.previous.landed], reject:[c.current.rejectRate,c.previous.rejectRate],
        title:root.querySelector('h2').textContent, sentence:root.querySelector('.window-sentence').textContent,
        ranges:root.querySelector('.window-range').textContent,
        expectedRange:[c.current.since,c.current.until,c.previous.since,c.previous.until].map(value=>new Date(value).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'})),
        tiles:keys.map(([key,share])=>{const tile=root.querySelector('[data-window-tile="'+key+'"]'), a=c.current[key], b=c.previous[key], d=c.change[key];
          return {key,value:tile.querySelector('b').textContent,expected:share?(a*100).toFixed(1)+'%':key==='landed'?String(a):a.toFixed(1),
            previous:tile.querySelector('small').textContent,expectedPrevious:'was '+(share?(b*100).toFixed(1)+'%':key==='landed'?String(b):b.toFixed(1)),
            tone:tile.classList.contains('good')?'good':tile.classList.contains('bad')?'bad':'',expectedTone:d===0?'':(d>0)===(key==='landed')?'good':'bad',
            change:tile.querySelector('.window-change').textContent};}),
        stages:[...root.querySelectorAll('[data-window-stage]')].map(node=>{const [period,key]=node.dataset.windowStage.split('.');return [Number(node.dataset.share),c[period].stageShares[key],node.getBoundingClientRect().width/node.ownerSVGElement.getBoundingClientRect().width];}),
        tableOpen:root.querySelector('details').open, summary:root.querySelector('summary').textContent,
        visible:root.querySelector('.window-tiles').getBoundingClientRect().height>0 };
    })())`));
    assert.deepEqual(result.landed,[1,2]);
    assert.deepEqual(result.reject,[0,1/3]);
    assert.equal(result.title,'The last two hours');
    assert.match(result.sentence,/Landed: 1, down from 2/u);
    assert.match(result.sentence,/Sent back: 0.0%, down from 33.3%/u);
    for (const label of result.expectedRange) assert.ok(result.ranges.includes(label),label);
    assert.doesNotMatch(result.ranges,/T\d{2}:|\d{1,2}:\d{2}:\d{2}/u);
    for (const tile of result.tiles) {
      assert.equal(tile.value,tile.expected,tile.key); assert.equal(tile.previous,tile.expectedPrevious,tile.key); assert.equal(tile.tone,tile.expectedTone,tile.key);
      if (['rejectRate','idleShare'].includes(tile.key)) assert.match(tile.change,/pts|No change/u);
    }
    assert.equal(result.stages.length,10);
    for (const [shown,expected,flex] of result.stages) {assert.equal(shown,expected);assert.ok(Math.abs(flex-expected)<0.000001,'Rendered stage share mismatch: ' + JSON.stringify({shown,expected,flex,stages:result.stages}));}
    assert.equal(result.visible,true); assert.equal(result.tableOpen,false); assert.equal(result.summary,'All 17 measures →');
    await chrome.click('document.querySelector("#dashboard .window-comparison summary")');
    await chrome.waitFor('document.querySelector("#dashboard .window-comparison details").open');
    assert.equal(await chrome.stable('document.querySelectorAll("#dashboard [data-stats-comparison]").length'),17);
    for (const width of [1440,375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await chrome.waitFor('innerWidth === '+width);
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= innerWidth'),true,'comparison fits at '+width);
    }
  } finally {if(chrome) await closeSnapshotChrome(chrome); await server.stop();}
});
