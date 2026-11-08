// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** The Cost overview renders the server analytics contract in Chrome [N26]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { costOverviewHtml, bindCostOverview } from '../../apps/view/index.js';
import { modelPresentation } from '../../apps/view/index.js';
import { costAnalytics } from '../../packages/stats/index.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../apps/cli/index.js';
import { chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

test('the private Cost overview renders prepared analytics and each confidence [N26]', { timeout: 90000 }, async () => {
  const executable = chromeExecutable(); assert.ok(executable);
  const fixture = { version: 1, window:'7d', totals:{agentMs:7200000,medianItemMs:3600000,sentBack:{itemShare:.5,agentMsShare:.6}}, days:[{date:'2026-10-30',firstTimeMs:3600000,sentBackMs:3600000,items:2}], builders:{verdict:'leaning',best:'a',runnerUp:'b',rows:[{model:'a',label:'Model A',vendor:'Vendor',built:31,rate:.8,low:.6,high:.9,typicalItemMs:3600000},{model:'b',label:'Model B',built:30,rate:.7,low:.5,high:.9}]}, verifiers:{verdict:'nothing-to-compare',best:'a',rows:[{model:'a',label:'Model A',accepts:31,verdicts:35,rate:.1,low:.05,high:.2}]}, unknownBuilderModelShare:.1,longest:[{id:1,title:'Long item',agentMs:7200000,sentBack:2,verifiedBy:'Model A',sessions:[{label:'Model A',count:1,agentMs:7200000,tokensIn:null}]}],allItems:2};
  const css = readFileSync(new URL("../../apps/view/src/shell/view.css", import.meta.url),'utf8') + readFileSync(new URL("../../apps/view/src/shell/view/cost.css", import.meta.url),'utf8');
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
    assert.equal(await chrome.stable("document.querySelectorAll('.cost-model-table').length"), 1, 'building and verifying share the model table');
    assert.match(await chrome.stable("document.querySelector('.cost-model-table').innerText"), /Accepted, came back later/u);

    await chrome.click("document.querySelector('[data-cost-window=\"30d\"]')");
    await chrome.waitFor("document.querySelector('[data-cost-window=\"30d\"]').getAttribute('aria-pressed') === 'true'");
    await chrome.click("document.querySelector('[data-go]')");
    await chrome.click("document.querySelector('[data-cost-copy]')");
    await chrome.click("document.querySelector('[data-cost-all]')");
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify(window.calls)')), ['item:1', 'Add model prices to Pullboard', 'all']);
    const unknown = costOverviewHtml({...fixture, longest:[{id:2,title:'Unknown',agentMs:null,sentBack:0,sessions:[{label:'Unknown model',count:null,agentMs:null,tokensIn:null}]}]}, 2);
    assert.doesNotMatch(unknown, /0 sessions|cost-time-bar/u);
    assert.match(unknown, /No token count/u);
    const dated = costOverviewHtml({...fixture, longest:[{id:3,title:'Dated',agentMs:1,landedAt:'2026-10-30T12:00:00Z',sessions:[]}]}, 3);
    assert.match(dated, /datetime="2026-10-30T12:00:00Z"/u);
    assert.doesNotMatch(dated, />2026-10-30T12:00:00Z</u);
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await new Promise(resolve => server.close(resolve)); rmSync(dir,{recursive:true,force:true}); }
});

test('the private Cost tab consumes the server projection and routes controls [N26]', { timeout: 120_000 }, async () => {
  const { machine, project, startView, press, serveFolder } = await import('./fixture.js');
  const box = machine(), alpha = project(box, 'cost-projection');
  box.run(alpha.repo, 'add', 'web', 'Seeded item', '--specs', 'G1', '--criterion', 'Appears in the private Cost view.');
  const view = await startView(box), dir = mkdtempSync(join(tmpdir(), 'cost-projection-')); let chrome;
  try {
    chrome = await openSnapshotChrome(chromeExecutable(), view.link.href, join(dir, 'chrome'));
    await chrome.waitFor('!!data?.project');
    await press(chrome, 'document.querySelector("[data-tab=cost]")');
    await chrome.waitFor('!!document.querySelector("#cost .cost-model-card")');
    assert.ok((await chrome.stable('document.querySelector("#cost").innerText')).includes('Showing agent time'));
    await press(chrome, 'document.querySelector("[data-tab=items]")');
    const projection = { version:1, window:'7d', totals:{agentMs:7200000,itemCount:1,medianItemMs:7200000,sentBack:{items:0,itemShare:0,agentMs:0,agentMsShare:0}}, days:[{date:'2026-10-30',firstTimeMs:7200000,sentBackMs:0,items:1}], builders:{verdict:'nothing-to-compare',best:'a',runnerUp:null,rows:[{model:'a',label:'Fixture model',vendor:'Fixture',built:30,passedFirst:29,rate:.967,low:.83,high:.99,typicalItemMs:7200000,judged:true,tooFew:false}]}, verifiers:{verdict:'clear',best:'b',runnerUp:'c',rows:[{model:'b',label:'Reviewer B',vendor:'Fixture',verdicts:31,accepts:30,reopenedLater:1,rate:.03,low:.01,high:.16,judged:true,tooFew:false},{model:'c',label:'Reviewer C',vendor:'Fixture',verdicts:35,accepts:32,reopenedLater:8,rate:.25,low:.13,high:.42,judged:true,tooFew:false}]}, unknownBuilderModelShare:0,longest:[{id:1,title:'Seeded item',agentMs:7200000,sentBack:0,verifiedBy:'Reviewer B',landedAt:'2026-10-30T12:00:00Z',sessions:[{model:'a',label:'Fixture model',count:null,agentMs:7200000,tokensIn:null}]}],allItems:1 };
    await chrome.stable(`(() => { const original=window.fetch; window.costRequests=[]; window.fetch=(input,init) => { const url=String(input); if (!url.includes('/cost-analytics?')) return original(input,init); const windowName=new URL(url,location.href).searchParams.get('window'); costRequests.push(windowName); return Promise.resolve(new Response(JSON.stringify({costAnalytics:{...${JSON.stringify(projection)},window:windowName}}),{status:200,headers:{'content-type':'application/json'}})); }; })()`);
    await chrome.stable('costHistory.clear()');
    await press(chrome, 'document.querySelector("[data-tab=cost]")');
    await chrome.waitFor('!!document.querySelector("#cost .cost-model-card")');
    let text = await chrome.stable('document.querySelector("#cost").innerText');
    for (const expected of ['Showing agent time','Fixture model','Nothing to compare','Clear','Seeded item']) assert.ok(text.includes(expected),expected);
    await chrome.click('document.querySelector("#cost [data-cost-row]")');
    await chrome.waitFor('document.querySelector("#cost .cost-detail")');
    text = await chrome.stable('document.querySelector("#cost .cost-detail").innerText');
    assert.ok(text.includes('No token count')); assert.ok(!text.includes('0 sessions'));
    await chrome.click('document.querySelector("#cost [data-cost-window=\\"30d\\"]")');
    await chrome.waitFor('document.querySelector("#cost [data-cost-window=\\"30d\\"]")?.getAttribute("aria-pressed") === "true"');
    assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify(window.costRequests)')), ['7d','30d']);
    await chrome.click('document.querySelector("#cost [data-cost-all]")');
    await chrome.waitFor('view.tab === "items"');
    assert.doesNotMatch(cockpitPage('', { snapshot:true, readOnly:true }), /costOverviewHtml|cost-analytics|Only you see this/u, 'public snapshots omit private Cost implementation');
    assert.deepEqual(chrome.exceptions, []);
    const output = join(dir, 'public');
    box.run(alpha.repo, 'view', '--export', output, '--public');
    const publicView = await serveFolder(output, '/public/');
    let publicChrome;
    try {
      publicChrome = await openSnapshotChrome(chromeExecutable(), publicView.base + '/public/', join(dir, 'public-chrome'));
      await publicChrome.waitFor('snapshot && !!data?.project');
      assert.equal(await publicChrome.stable('!!document.querySelector("[data-tab=cost]")'), false);
      await press(publicChrome, 'document.querySelector("[data-tab=items]")');
      await publicChrome.waitFor('view.tab === "items"');
      assert.deepEqual(publicChrome.exceptions, []);
    } finally { if (publicChrome) await closeSnapshotChrome(publicChrome); await publicView.close(); }
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); rmSync(dir,{recursive:true,force:true}); }
});

test('Cost names merge, the unrecorded note hides at zero, and unknown durations stay out of the totals [N26]', () => {
  assert.equal(modelPresentation('GPT-6/openai').name, 'GPT-6', 'a /vendor suffix is dropped before matching');
  assert.deepEqual([modelPresentation('GPT-6/openai').key, modelPresentation('GPT-6').key], ['gpt-6', 'gpt-6']);
  assert.equal(modelPresentation('GPT-6 Codex').name, 'Codex');
  assert.equal(modelPresentation('GPT-6/openai').vendor, 'OpenAI');
  const base = { version: 1, window: '7d', totals: { agentMs: 7200000, itemCount: 2, sentBack: { itemShare: 0, agentMsShare: 0, agentMs: 0 } }, days: [{ date: '2026-10-28', firstTimeMs: 3600000, sentBackMs: 3600000, items: 2 }], builders: { rows: [] }, verifiers: { rows: [] }, longest: [], allItems: 2 };
  assert.doesNotMatch(costOverviewHtml({ ...base, unknownBuilderModelShare: 0 }), /record which model built them/u, 'no note at 0%');
  assert.match(costOverviewHtml({ ...base, unknownBuilderModelShare: 0.5 }), /50% of items don't record which model built them/u);
  const html = costOverviewHtml(base);
  assert.match(html, />Wed<\/text>/u, 'the axis names the weekday');
  assert.match(html, /<title>Wednesday, Oct 28\n2 items landed/u, 'each bar has a tooltip');
  assert.match(html, /<text class="v"[^>]*>2\.0 h<\/text>/u, 'each bar carries its hours');
  assert.doesNotMatch(html, /🔒/u, 'a line lock icon, not the emoji');
  const at = '2026-10-28T15:00:00.000Z', event = (id, kind, item, by, detail = {}) => ({ event_id: id, event_kind: kind, item_id: item, event_by: by, event_at: at, event_detail: JSON.stringify(detail) });
  const result = costAnalytics({ items: [{ item_id: 1, item_title: 'A' }, { item_id: 2, item_title: 'B' }], agents: [], window: '7d', now: new Date('2026-10-30T12:00:00Z'), timeZone: 'UTC', modelPresentation,
    events: [event(1, 'submit', 1, 'x'), event(2, 'merged', 1, 'x'), event(3, 'merged', 2, 'x'), event(4, 'usage', 1, 'x', { item: 1, revision: 1, records: [{ model: 'M', wallMs: 3600000, inputTokens: 5 }, { model: 'M', wallMs: 3600000, inputTokens: 5 }] })] });
  assert.equal(result.totals.itemCount, 2);
  assert.equal(result.totals.agentMs, 7200000, 'an item with no recorded time does not blank the total');
  assert.equal(result.days[0].firstTimeMs, 7200000, 'nor the day');
  assert.equal(result.longest[0].sessions[0].count, 2, 'a model line counts its sessions');
});

test('two model ids with one display name make one row, untimed days say so, and the group row has no stray line [N26]', () => {
  const at = '2026-10-25T15:00:00.000Z', event = (id, kind, item, by, detail = {}) => ({ event_id: id, event_kind: kind, item_id: item, event_by: by, event_at: at, event_detail: JSON.stringify(detail) });
  const analytics = costAnalytics({ items: [{ item_id: 1, item_title: 'A' }, { item_id: 2, item_title: 'B' }, { item_id: 3, item_title: 'C' }], agents: [], window: '7d', now: new Date('2026-10-26T12:00:00Z'), timeZone: 'UTC', modelPresentation,
    events: [event(1, 'submit', 1, 'x', { model: 'gpt-6-codex' }), event(2, 'merged', 1, 'x'), event(3, 'submit', 2, 'y', { model: 'codex' }), event(4, 'merged', 2, 'y'), event(5, 'submit', 3, 'z', { model: 'sonnet-5.5' }), event(6, 'reject', 3, 'r'), event(7, 'merged', 3, 'z')] });
  assert.deepEqual(analytics.builders.rows.map(row => [row.label, row.built]).sort(), [['Codex', 2], ['Sonnet 5.5', 1]], 'gpt-6-codex and codex are one Codex row');
  assert.equal(modelPresentation('claude-sonnet-5.5').key, modelPresentation('claude-sonnet-5-5').key, 'one name, one match key');
  assert.deepEqual(analytics.days.map(day => [day.items, day.firstTimeMs, day.sentBackMs]), [[3, null, null]], 'a day with items and no recorded time');
  const html = costOverviewHtml(analytics);
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  assert.equal(body.match(/<th scope="row">.*?>Codex <small>/gu)?.length, 1, 'the Models table shows one Codex row');
  assert.match(html, /class="unrecorded"[^>]*><tspan[^>]*>time not<\/tspan><tspan[^>]*>recorded<\/tspan>/u, 'a wide untimed column carries the label');
  const month = costOverviewHtml({ window: '30d', totals: {}, days: Array.from({ length: 30 }, (_, index) => ({ date: '2026-10-' + String(index + 1).padStart(2, '0'), firstTimeMs: null, sentBackMs: null, items: 1 })), builders: { rows: [] }, verifiers: { rows: [] } });
  assert.equal(month.match(/class="unrecorded"[^>]*transform="rotate\(-90 [^"]*"[^>]*>time not recorded</gu)?.length, 30, 'a narrow untimed column runs its label upright');
  assert.match(html, /<th class="grp-gap"><\/th>/u, 'the empty group cell draws no partial line');
});
