/** The two-hour window comparison, which moved from the Dashboard to Activity (#6647, #6847) [N26,R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonHtml } from '../../../src/logic/render/comparison.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardData } from '../../fixtures/cockpit/data.js';
import { compareFlowWindows } from '../../../../../packages/stats/browser.js';

/** Extract a single named section so row assertions stay scoped. */
function section(html, name) {
  const start = html.indexOf(`aria-label="${name}"`);
  assert.notEqual(start, -1, `renders ${name}`);
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, `${name} section closes`);
  return html.slice(start, end);
}

test('view.x-render-comparison.activity-comparison-consumes-labelled-api-comparison-scalars: Activity comparison consumes labelled API comparison scalars without rebuilding their history [N26,R1,R2]', () => {
  const input = dashboardData({ populated: true });
  const current = { since:'2026-10-28T10:00:00.000Z', until:'2026-10-28T12:00:00.000Z', landed:2, agentHours:4, agentHoursPerLanding:2, idleShare:0.5, submitsPerItem:1.5, rejectRate:0.25, shoutsPerLanding:1,
    idleReasons:{'nothing-eligible':0.1,held:0.1,'review-family':0.1,'main-red':0.1,unknown:0.1}, stageShares:{build:0.2,rework:0.2,reviewWait:0.2,review:0.2,land:0.2} };
  const previous = { ...structuredClone(current), since:'2026-10-28T08:00:00.000Z', until:'2026-10-28T10:00:00.000Z', landed:1, agentHoursPerLanding:4, idleShare:null };
  const change = { landed:1,agentHours:0,agentHoursPerLanding:-2,idleShare:null,submitsPerItem:0,rejectRate:0,shoutsPerLanding:0,
    idleReasons:{'nothing-eligible':0,held:0,'review-family':0,'main-red':0,unknown:0},stageShares:{build:0,rework:0,reviewWait:0,review:0,land:0} };
  input.project.statsComparison = { version:1,available:true,durationMinutes:120,current,previous,change };
  const before = JSON.stringify(input.project.statsComparison);
  const model = dashboardModel(input.project, [], { now:input.clockBase,complete:false });
  assert.strictEqual(model.comparison,input.project.statsComparison,'API comparison remains authoritative even while browser history is loading');
  const html = section(comparisonHtml(model.comparison),'Window comparison');
  assert.match(html,/data-stats-as-of="2026-10-28T12:00:00.000Z"/u);
  assert.ok(html.includes(new Date(current.until).toLocaleTimeString('en-US', { timeZone:'UTC', hour:'numeric', minute:'2-digit' })), 'canonical observation time uses the supplied display zone');
  assert.match(html,/120-minute windows/u);
  assert.equal([...html.matchAll(/data-stats-comparison=/gu)].length,17);
  assert.match(html,/data-stats-comparison="landed" data-current="2" data-previous="1" data-change="1"/u);
  assert.match(html,/data-stats-comparison="agentHoursPerLanding" data-current="2" data-previous="4" data-change="-2"/u);
  assert.match(html,/unmeasured/u);
  assert.match(html,/percentage points/u);
  assert.match(html,/all observed seat-hours as their denominator/u);
  assert.match(html,/data-stats-comparison="idleShare" data-current="0.5" data-previous="null" data-change="null"/u);
  assert.equal(JSON.stringify(input.project.statsComparison),before,'rendering never alters metric evidence');
});


test('view.x-render-comparison.activity-comparison-preserves-unavailable-comparison-reasons-and: Activity comparison preserves unavailable comparison reasons and never turns missing evidence into zero [N26]', () => {
  const input = dashboardData({ populated: true });
  input.project.statsComparison = { version:1, available:false, reason:'No recorded seat intervals <yet>' };
  const html = section(comparisonHtml(input.project.statsComparison), 'Window comparison');
  assert.match(html,/No recorded seat intervals &lt;yet&gt;/u);
  assert.doesNotMatch(html,/data-stats-comparison=/u);
  delete input.project.statsComparison;
  assert.equal(comparisonHtml(input.project.statsComparison), '', 'a board with no comparison draws nothing');
  assert.doesNotMatch(dashboardHtml(dashboardModel(input.project,input.events,{ now:input.clockBase,complete:true })),/aria-label="Window comparison"/u, 'and the Dashboard never draws it');
});


test('view.x-render-comparison.seeded-event-windows-reach-the-activity-comparison: seeded event windows reach the Activity comparison rows through the canonical projection [N26,R1,R2]', () => {
  const input = dashboardData({ populated: true });
  const base = input.clockBase - 240 * 60_000;
  /** Fix every event at an exact minute so no host clock supplies a measurement. */
  function at(minutes) { return new Date(base + minutes * 60_000).toISOString(); }
  const rows = [
    [0,'core-1','join',null,{lane:'core'}], [0,'review-1','join',null,{lane:'review'}],
    [0,'coordinator','add',1,{lane:'core'}], [10,'core-1','claim',1,{leaseUntil:at(300)}],
    [20,'core-1','submit',1,{commit:'a'.repeat(40)}], [30,'review-1','reserve',1,{until:at(300)}],
    [40,'review-1','accept',1,{commit:'a'.repeat(40)}], [60,'coordinator','merged',1,{}],
    [80,'core-1','shout',null,{to:'coordinator'}], [130,'coordinator','add',2,{lane:'core'}],
    [135,'core-1','claim',2,{leaseUntil:at(300)}], [140,'core-1','shout',null,{to:'coordinator'}],
    [150,'core-1','submit',2,{commit:'b'.repeat(40)}], [160,'core-1','shout',null,{to:'coordinator'}],
    [165,'review-1','reserve',2,{until:at(300)}], [175,'review-1','accept',2,{commit:'b'.repeat(40)}],
    [180,'coordinator','merged',2,{}],
  ];
  // Plain event inputs exercise the shared projection, not a fabricated operational board or proof receipt.
  const history = rows.map(([minute,by,kind,id,detail],index) => ({ event_id:index+1,event_at:at(minute),event_by:by,event_kind:kind,item_id:id,event_detail:JSON.stringify(detail) }));
  const original = JSON.stringify(history);
  const comparison = compareFlowWindows(history, { now:input.clockBase,windowMinutes:120,complete:true });
  assert.equal(comparison.current.landed,1);
  assert.equal(comparison.previous.landed,1);
  assert.equal(comparison.current.agentHours,4,'two observed seats span the two-hour window');
  assert.equal(comparison.current.agentHoursPerLanding,4);
  assert.equal(comparison.current.shoutsPerLanding,2);
  assert.equal(comparison.previous.shoutsPerLanding,1);
  assert.equal(comparison.change.shoutsPerLanding,1);
  assert.equal(comparison.current.idleReasons.unknown,comparison.current.idleShare,'unrecorded historical reasons remain unknown');
  input.project.statsComparison = comparison;
  const html = section(comparisonHtml(comparison),'Window comparison');
  const metrics = [
    ...['landed','agentHours','agentHoursPerLanding','idleShare','submitsPerItem','rejectRate','shoutsPerLanding'].map(key => [key,null]),
    ...['nothing-eligible','held','review-family','main-red','unknown'].map(key => [key,'idleReasons']),
    ...['build','rework','reviewWait','review','land'].map(key => [key,'stageShares']),
  ];
  for (const [key,group] of metrics) {
    const name = group ? group+'.'+key : key;
    const values = ['current','previous','change'].map(period => JSON.stringify(group ? comparison[period][group][key] : comparison[period][key]));
    assert.ok(html.includes('data-stats-comparison="'+name+'" data-current="'+values[0]+'" data-previous="'+values[1]+'" data-change="'+values[2]+'"'),name+' preserves its canonical values');
  }
  assert.equal(JSON.stringify(history),original,'the pure renderer does not change recorded inputs');
});
