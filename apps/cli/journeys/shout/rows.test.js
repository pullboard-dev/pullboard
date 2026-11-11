// pullboard: browser
/** @pullboard-test-gui */
/** Native questions retain their full text/actions while summaries name the actual item [N26,B26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  machine,
  project,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

test('Needs you summarizes item809, keeps raw questions in details and places navigation in its header [N26,B26]', { timeout:120_000 }, async () => { // budget: native809-item seed, authenticated HTTP and real Chrome at desktop/phone widths.
  const box=machine();
  const spec='# Needs rows\n\n## G · Goals\n- G1 [draft, must] Keep a person decision readable. | gate: browser test\n- G2 [draft, aim] Keep another draft visible in the count. | gate: browser test\n';
  const demo=project(box,'needs-you-rows',spec);
  const title='Choose the release wording without losing its exact person decision';
  // @pullboard-board-file journey: native writers seed a real item809 without editing counters or private database rows.
  const board=openBoard(join(demo.repo,'.git/pullboard/board.sqlite'));
  try {
    for(let id=1;id<=809;id++) assert.equal(store.addItem(board,{by:'coordinator',lane:'web',title:id===809?title:'Earlier fixture item '+id,criterion:'A private native presentation fixture.',specIds:['G1']}),id);
  } finally {store.closeBoard(board);}
  const question='#809: Please choose the exact release wording after considering the full context. This long native question must remain intact in the expanded detail, including this final sentence.';
  for(let n=0;n<4;n++) box.run(demo.repo,'shout','person',question+' Choice '+(n+1)+'.','--decision');
  const server=await startView(box);
  let chrome;
  try {
    const before=await boardOf(server,demo.repo);
    const asks=before.decisions.map(row=>row.shout_id);
    assert.equal(asks.length,4);
    const executable=chromeExecutable();assert.ok(executable,'real Chrome is required');
    chrome=await openSnapshotChrome(executable,'about:blank',join(box.dir,'needs-you-chrome'));
    await chrome.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await chrome.send('Page.navigate',{url:server.link.href});
    await chrome.waitFor('typeof view === "object" && !!view.root');
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.waitFor('document.querySelectorAll("#dashboard .needs-call").length === 3');
    for(const width of [1440,375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await chrome.waitFor('innerWidth === '+width);
      const result=JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const card=document.querySelector('#dashboard .needs-card'), rows=[...card.querySelectorAll('.needs-call')];
        const header=card.querySelector('header'), more=header.querySelector('[data-needs-list]');
        return {text:card.innerText, header:header.textContent, more:more?.textContent,
          heading:header.querySelector('h2').textContent, footerRows:card.querySelectorAll('ol > .needs-more').length,
          titles:rows.map(row=>({text:row.querySelector('.needs-copy b').textContent,nowrap:getComputedStyle(row.querySelector('.needs-copy b')).whiteSpace})),
          lastBorder:getComputedStyle(rows.at(-1)).borderBottomWidth,
          actions:rows.map(row=>row.querySelector('.needs-detail .actions [data-go]')?.dataset.go),
          overflow:document.documentElement.scrollWidth>innerWidth};
      })())`));
      assert.equal(result.heading,'Needs you');
      assert.equal(result.more,'1 more and 2 draft rows →');
      assert.equal(result.footerRows,0);
      assert.equal(result.lastBorder,'0px');
      assert.equal(result.overflow,false);
      assert.equal(result.titles.length,3);
      for(const row of result.titles) {assert.equal(row.text,'#809Decide: '+title);assert.equal(row.nowrap,'nowrap');}
      assert.ok(!result.text.includes(question),'the full question is not the collapsed title');
      for(const id of asks) assert.doesNotMatch(result.text,new RegExp('#'+id+'\\b','u'),'no visible shout id');
      assert.deepEqual(result.actions,asks.slice(0,3).map(id=>'decide:'+id),'summary identities never replace the actual native action targets');
    }
    await chrome.click('document.querySelector("#dashboard .needs-call summary")');
    await chrome.waitFor('document.querySelector("#dashboard .needs-call details").open');
    assert.ok((await chrome.stable('document.querySelector("#dashboard .needs-call .needs-detail").innerText')).includes(question+' Choice 1.'),'expansion preserves the original words');
    await chrome.stable('render(); true');
    assert.equal(await chrome.stable('document.querySelector("#dashboard .needs-card header [data-needs-list]").textContent'),'1 more and 2 draft rows →','redraw retains the header navigation');
    await chrome.click('document.querySelector("#dashboard .needs-card header [data-needs-list]")');
    await chrome.waitFor('view.tab === "items" && document.querySelectorAll("#needs [data-needs-key]").length === 4');
    assert.equal(await chrome.stable('document.querySelector("#needs .needs-copy b").textContent'),'#'+asks[0]+question+' Choice 1.', 'the complete Needs list retains the original native question after compact navigation');
  } finally {if(chrome) await closeSnapshotChrome(chrome);await server.stop();}
});
