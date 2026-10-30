/** @pullboard-test-gui */
/** The Cost overview renders the server analytics contract in Chrome [N26]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { costOverviewHtml, bindCostOverview } from '../../src/view/cost-overview.js';
import { chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('the private Cost overview renders prepared analytics and each confidence [N26]', { timeout: 90000 }, async () => {
  const executable = chromeExecutable(); assert.ok(executable);
  const fixture = { version: 1, window:'7d', totals:{agentMs:7200000,medianItemMs:3600000,sentBack:{itemShare:.5,agentMsShare:.6}}, days:[{date:'2026-10-30',firstTimeMs:3600000,sentBackMs:3600000,items:2}], builders:{verdict:'leaning',best:'a',runnerUp:'b',rows:[{model:'a',label:'Model A',vendor:'Vendor',built:31,rate:.8,low:.6,high:.9,typicalItemMs:3600000},{model:'b',label:'Model B',built:30,rate:.7,low:.5,high:.9}]}, verifiers:{verdict:'nothing-to-compare',best:'a',rows:[{model:'a',label:'Model A',accepts:31,verdicts:35,rate:.1,low:.05,high:.2}]}, unknownBuilderModelShare:.1,longest:[{id:1,title:'Long item',agentMs:7200000,sentBack:2,verifiedBy:'Model A',sessions:[{label:'Model A',count:1,agentMs:7200000,tokensIn:null}]}],allItems:2};
  const css = readFileSync(new URL('../../src/view.css', import.meta.url),'utf8') + readFileSync(new URL('../../src/view/cost.css', import.meta.url),'utf8');
  const html = '<!doctype html><style>' + css + '</style><main id="cost">' + costOverviewHtml(fixture, 1) + '</main><script>const costOverviewHtml = ' + costOverviewHtml.toString() + '; const bindCostOverview = ' + bindCostOverview.toString() + '; window.calls = []; bindCostOverview(document.querySelector("#cost"), {readWindow: async window => ({...'+JSON.stringify(fixture)+',window}), openItem: id => calls.push("item:"+id), showAll: () => calls.push("all"), copyText: text => calls.push(text)});</script>'; 
  const server = createServer((_q,r) => r.writeHead(200,{'content-type':'text/html'}).end(html)); const dir = mkdtempSync(join(tmpdir(),'cost-redesign-')); let chrome;
  try { await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); chrome = await openSnapshotChrome(executable,'http://127.0.0.1:'+server.address().port,join(dir,'chrome'));
    await chrome.waitFor('!!document.querySelector(".cost-model-card")');
    await chrome.click("document.querySelector('[data-cost-row]')");
    const text = await chrome.stable('document.body.innerText');
    for (const expected of ['Showing agent time','Leaning','Nothing to compare','AGENT TIME EACH DAY','50%','60%','Long item','No token count']) assert.ok(text.includes(expected), expected);
    assert.match(costOverviewHtml({...fixture, builders:{...fixture.builders,verdict:'clear'}}), /Clear/u);
    assert.doesNotMatch(costOverviewHtml(fixture, null, {hasPrices:true}), /Want dollars/u);
    const geometry = JSON.parse(await chrome.stable(`JSON.stringify((() => { const bar=document.querySelector('.cost-chart-bar'), parts=[...bar.querySelectorAll('rect')].map(e=>({y:Number(e.getAttribute('y')),height:Number(e.getAttribute('height'))})); return {parts,ranges:document.querySelectorAll('.cost-range').length,split:document.querySelectorAll('.cost-split rect').length}; })())`));
    assert.equal(geometry.parts.length,2); assert.equal(geometry.parts[1].y + geometry.parts[1].height, geometry.parts[0].y, 'daily segments stack without overlap');
    assert.ok(geometry.ranges >= 2); assert.equal(geometry.split,2);
    await chrome.click("document.querySelector('[data-cost-window=\"30d\"]')");
    await chrome.waitFor("document.querySelector('[data-cost-window=\"30d\"]').getAttribute('aria-pressed') === 'true'");
    await chrome.click("document.querySelector('[data-go]')");
    await chrome.click("document.querySelector('[data-cost-copy]')");
    await chrome.click("document.querySelector('[data-cost-all]')");
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify(window.calls)')), ['item:1', 'Add model prices to Pullboard', 'all']);
    const unknown = costOverviewHtml({...fixture, longest:[{id:2,title:'Unknown',agentMs:null,sentBack:0,sessions:[{label:'Unknown model',count:null,agentMs:null,tokensIn:null}]}]}, 2);
    assert.doesNotMatch(unknown, /0 sessions|cost-time-bar/u);
    assert.match(unknown, /No token count/u);
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await new Promise(resolve => server.close(resolve)); rmSync(dir,{recursive:true,force:true}); }
});
