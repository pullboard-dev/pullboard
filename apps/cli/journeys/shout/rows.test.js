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

test('Rulings keeps raw questions in details, and the notch opens the full list from the Dashboard [N26,B26]', { timeout:120_000 }, async () => { // budget: native809-item seed, authenticated HTTP and real Chrome at desktop/phone widths.
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
    // The /live-style Dashboard draws no Rulings card (#6847): the notch carries the count and opens the full list.
    await chrome.waitFor('Number(document.querySelector("#notch [data-notch=rulings]")?.textContent) >= 4 && !!document.querySelector("#dashboard .dash-live")');
    assert.equal(await chrome.stable('document.querySelectorAll("#dashboard .needs-card, #dashboard .needs-call").length'),0,'the Dashboard holds no Rulings rows');
    const openOn = place => 'document.querySelectorAll("'+place+' .needs-call details[open]").length';
    await chrome.click('document.querySelector("#notch [data-peek=rulings]")');
    await chrome.waitFor('view.tab === "items" && document.querySelectorAll("#needs [data-needs-key]").length === 4');
    assert.equal(await chrome.stable('document.querySelector("#needs .needs-copy b").textContent'),'#'+asks[0]+question+' Choice 1.', 'the complete Needs list retains the original native question after compact navigation');
    assert.equal(await chrome.stable(openOn('#needs')),0,'#6595: no Items Rulings row opens by default');
    await chrome.click('document.querySelectorAll("#needs .needs-call summary")[1]');
    await chrome.waitFor('document.querySelectorAll("#needs .needs-call details")[1].open');
    await chrome.stable('render(); true');
    assert.equal(await chrome.stable('document.querySelectorAll("#needs .needs-call details")[1].open && '+openOn('#needs')+' === 1'),true,'#6595: the opened Items row stays open, alone, across a live redraw');
    await chrome.click('document.querySelectorAll("#needs .needs-call summary")[1]');
    await chrome.waitFor(openOn('#needs')+' === 0');
    await chrome.stable('render(); true');
    assert.equal(await chrome.stable(openOn('#needs')),0,'#6595: the closed Items row stays closed across a live redraw');
  } finally {if(chrome) await closeSnapshotChrome(chrome);await server.stop();}
});
