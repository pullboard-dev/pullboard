/** View rendering logic receives plain data and returns HTML without a browser or native board [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordRowHtml } from '../../src/logic/row.js';
import { pipelineHtml } from '../../src/logic/pipeline/render.js';
import { selectItemsView } from '../../src/logic/selection.js';
import { timelineBodyHtml } from '../../src/logic/timeline/body.js';
import { timelineHtml } from '../../src/logic/timeline/render.js';
import { lifecycleDiagramHtml } from '../../src/logic/lifecycle/diagram.js';
import { needsEntries } from '../../src/logic/needs/list.js';
import { renderNeedsRow } from '../../src/logic/needs/list.js';
import { needsPanelHtml } from '../../src/logic/needs/panel.js';
import { needsPanelModel } from '../../src/logic/needs/panel.js';
import { homeRules } from '../../src/logic/home.js';
import { roadmapSummary } from '../../src/logic/summary/roadmap.js';
import { roadmapHeaders } from '../../src/logic/summary/roadmap.js';
import { roadmapBlock } from '../../src/io/roadmap/block.js';
import { dashboardModel } from '../../src/io/dashboard/model.js';
import { activityWords } from '../../src/logic/activity/words.js';
import { viewTestProblems } from '../../src/io/coverage.js';
import { ruleListModel } from '../../src/logic/rules.js';

test('Spec and Doctrine selection keeps local decisions, inherited defaults and addressed rows explicit [N26,B26,C7]', () => {
  const rows = [
    { id: 'G1', section: 'Goals', status: 'draft' },
    { id: 'G2', section: 'Goals', status: 'pending', decision: { decision: 'decline' } },
    { id: 'G3', section: 'Rules', status: 'approved' },
    { id: 'G4', section: 'Rules', status: 'approved', staleDecision: true },
    { id: 'G5', section: 'Defaults', status: 'pending', origin: 'standard' },
  ];
  const before = JSON.stringify(rows);
  const spec = ruleListModel(rows, { kind: 'spec', filter: 'decide', selectedId: 'G2', approvalIds: ['G3'],
    feedback: { id: 'missing', next: 'G4' } });
  assert.deepEqual(spec.shown.map(row => row.id), ['G1', 'G3', 'G4', 'G5']);
  assert.equal(spec.nextSelectedId, 'G1', 'a filtered selection falls back to the first visible row');
  assert.equal(spec.feedbackId, 'G4', 'feedback follows its explicit visible next row');
  assert.deepEqual([...spec.sectionCounts], [['Goals', 1], ['Rules', 2], ['Defaults', 1]]);
  assert.deepEqual(spec.counts, { decide: 4, defaults: 0, all: 5, approved: 2 });
  assert.equal('defaults' in spec.labels, false, 'Spec never advertises inherited Doctrine defaults');
  const doctrine = ruleListModel(rows, { kind: 'doctrine', filter: 'decide', approvalIds: ['G3'] });
  assert.deepEqual(doctrine.shown.map(row => row.id), ['G1', 'G4']);
  assert.equal(doctrine.counts.defaults, 1);
  assert.equal(doctrine.labels.defaults, 'To review');
  const defaults = ruleListModel(rows, { kind: 'doctrine', filter: 'defaults' });
  assert.deepEqual(defaults.shown.map(row => row.id), ['G5']);
  assert.deepEqual([...defaults.sectionCounts], [['standard:Defaults', 1]]);
  assert.deepEqual([...defaults.sectionReviewCounts], [['standard:Defaults', 1]], 'only pending defaults contribute to the section count');
  const approvedDefault = ruleListModel([...rows, { id: 'G6', section: 'Defaults', status: 'approved', origin: 'standard' }],
    { kind: 'doctrine', filter: 'approved' });
  assert.deepEqual([...approvedDefault.sectionReviewCounts], [['standard:Defaults', 1]], 'the header count still includes pending rules hidden by the current filter');
  assert.deepEqual(ruleListModel(rows, { kind: 'spec', filter: 'approved' }).shown.map(row => row.id), ['G3', 'G4']);
  const addressed = ruleListModel(rows, { kind: 'spec', filter: 'decide', selectedId: 'missing', addressed: true });
  assert.equal(addressed.nextSelectedId, 'missing', 'a missing addressed row must retain its not-found detail');
  assert.equal(ruleListModel([], { kind: 'spec', filter: 'all', selectedId: 'G1' }).nextSelectedId, null);
  assert.equal(JSON.stringify(rows), before, 'selection does not rewrite decisions or reorder source rows');
});

test('shared view rows render item, spec and doctrine presentation data without browser state [N26,C7]', () => {
  const item = Object.freeze({ attributes: 'data-item="12"', title: 'Use <tags> & "quotes"', state: 'building',
    primary: '<span>#12</span>Use &lt;tags&gt;', secondary: '<span>web</span>', rightTop: '<time>2m</time>',
    rightBottom: '<span class="chip busy">web-1</span>', classes: 'on gated ' });
  const html = recordRowHtml(item);
  assert.match(html, /^<li class="row s-building on gated" data-item="12" title="Use &lt;tags&gt; &amp; &quot;quotes&quot;">/u);
  assert.ok(html.includes('<div class="t srow-text">' + item.primary + '</div>'));
  assert.ok(html.includes('<span class="row-age">' + item.rightTop + '</span>'));
  assert.ok(html.includes('<div class="meta">' + item.secondary + '</div></div>' + item.rightBottom + '</li>'));
  assert.equal(recordRowHtml(item), html, 'the same frozen input produces the same HTML');
  for (const tag of ['li', 'div']) {
    const row = recordRowHtml({ tag, attributes: 'data-rule="G1"', title: "A person's rule", state: 'approved',
      primary: 'G1 The rule', secondary: 'this repo' });
    assert.ok(row.startsWith('<' + tag + ' class="' + (tag === 'div' ? 'srow ' : '') + 'row s-approved"'));
    assert.match(row, /title="A person&#39;s rule"/u);
    assert.ok(row.endsWith('</' + tag + '>'));
    assert.ok(!row.includes('row-age'), 'an absent time has no empty age decoration');
  }
});


test('Items selection applies explicit search, state, lane and rank observations without page state [N26,C7]', () => {
  const items = Object.freeze([
    { id: 4, lane: 'web', status: 'open', updatedAt: '2026-10-28T12:00:00Z' },
    { id: 2, lane: 'api', status: 'claimed', updatedAt: '2026-10-28T11:00:00Z' },
    { id: 3, lane: 'web', status: 'submitted', since: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T10:00:00Z' },
    { id: 1, lane: 'web', status: 'verified', updatedAt: '2026-10-28T08:00:00Z' },
    { id: 5, lane: 'web', status: 'withdrawn', updatedAt: '2026-10-28T07:00:00Z' },
  ]);
  const stateById = new Map([[4, { state: 'open', gated: true }], [2, { state: 'building', gated: false }],
    [3, { state: 'verify', gated: false }], [1, { state: 'verified', gated: false }], [5, { state: 'withdrawn', gated: false }]]);
  const ready = selectItemsView({ items, stateById, state: 'ready', lane: null, readyIds: [4, 2], dashboardList: 'next', dashboardNext: [2, 4] });
  assert.deepEqual(ready.shown.map(item => item.id), [2, 4], 'ready uses supplied rank order');
  assert.deepEqual(ready.stateOptions.map(option => [option.value, option.count]), [['active', 3], ['verified', 1], ['all', 4], ['ready', 2]]);
  const review = selectItemsView({ items, stateById, state: 'verify', lane: 'web', dashboardList: 'review' });
  assert.deepEqual(review.shown.map(item => item.id), [3], 'review uses supplied stage observation and lane');
  assert.equal(review.filterLabel, 'Filter: In review · web');
  const search = selectItemsView({ items, stateById, query: 'retired', matchedIds: [5], state: 'all', lane: 'missing' });
  assert.deepEqual(search.matching.map(item => item.id), [5], 'search can include withdrawn items');
  assert.deepEqual(items.map(item => item.id), [4, 2, 3, 1, 5], 'selection does not mutate the item list');
  assert.equal(search.selectedLane, null, 'a lane with no searched matches clears');
  const finished = selectItemsView({ items: [items[1]], stateById: new Map([[2, { state: 'verified' }]]), state: 'active',
    lane: null, selectedId: 99, currentBoard: true, tab: 'items' });
  assert.equal(finished.finishedUnderAll, true);
  assert.equal(finished.nextSelectedId, null, 'a finished active list has no selection to fall back to');
  const fallback = selectItemsView({ items: [items[0]], stateById: new Map([[4, { state: 'open', gated: false }]]),
    state: 'active', lane: null, selectedId: 99, currentBoard: true, tab: 'items' });
  assert.equal(fallback.nextSelectedId, 4, 'an invalid selection falls back to the first visible item');
  const addressed = selectItemsView({ items, stateById, state: 'active', lane: null, selectedId: 99,
    currentBoard: true, tab: 'items', addressDetail: '99' });
  assert.equal(addressed.nextSelectedId, 99, 'a direct item address keeps its missing id for the not-found detail');
  assert.throws(() => selectItemsView({ items, stateById: { 4: { state: 'open' } }, state: 'active' }), /stateById must be a Map/u);
});

test('lifecycle diagram HTML follows supplied declarations and counts without replay or browser geometry [N26,M1,C7]', () => {
  const flow = { initial: 'open', states: ['open', 'claimed', 'submitted', 'verified', 'withdrawn'].map(id => ({ id,
    final: ['verified', 'withdrawn'].includes(id), means: 'Meaning <' + id + '>', entry: [] })),
    moves: [['claim', ['open'], 'claimed'], ['submit', ['claimed'], 'submitted'], ['accept', ['submitted'], 'verified'],
      ['release', ['claimed'], 'open'], ['renew', ['claimed'], 'claimed'], ['rehomeImport', ['open'], 'verified'],
      ['withdraw', ['open', 'claimed', 'submitted'], 'withdrawn']].map(([verb, from, to]) => ({ verb, from, to,
      by: ['agent'], how: 'The ' + verb + ' move', checks: ['Keep <the rule>'] })) };
  const project = { items: [{ status: 'open', verdict: { decision: 'REJECT' } }, { status: 'claimed' },
    { status: 'submitted' }, { status: 'verified' }, { status: 'withdrawn' }] };
  const counts = new Map([['open>claimed:claim', 7], ['claimed>submitted:submit', 4], ['submitted>verified:accept', 3],
    ['claimed>open:release', 2], ['claimed>claimed:renew', 1], ['open>verified:rehomeImport', 5]]);
  const before = JSON.stringify({ flow, project, counts: [...counts] });
  const html = lifecycleDiagramHtml(project, flow, counts);
  assert.match(html, /^<svg viewBox="0 0 880 [\d.]+" role="img"/u);
  assert.match(html, /claim, open to claimed, by the agent: The claim move\. Made 7 times/u);
  assert.match(html, /rehomeImport, open to verified, by the agent: The rehomeImport move\. Made 5 times/u);
  assert.match(html, /Keep &lt;the rule&gt;/u);
  assert.match(html, /Meaning &lt;verified&gt;/u);
  assert.match(html, /class="edge back"/u);
  assert.match(html, /↻ renew 1/u);
  assert.match(html, /1 sent back/u);
  assert.ok(!/undefined|NaN/u.test(html), 'all declared routes have valid geometry and words');
  assert.equal(lifecycleDiagramHtml(project, flow, counts), html);
  assert.equal(JSON.stringify({ flow, project, counts: [...counts] }), before, 'layout does not mutate declaration, input rows or counts');
});


test('timeline HTML preserves supplied move and fact order, lapse rows, stays, replacements and code links [N26,B33,C7]', () => {
  const at = minute => new Date(Date.UTC(2026, 9, 28, 12, minute)).toISOString();
  const flow = Object.freeze({ initial: 'open', states: Object.freeze([
    Object.freeze({ id: 'open', final: false }), Object.freeze({ id: 'claimed', final: false }),
    Object.freeze({ id: 'verified', final: true }),
  ]) });
  const entries = Object.freeze([
    Object.freeze({ type: 'move', eventId: 1, kind: 'add', by: 'web-1', at: at(0) }),
    Object.freeze({ type: 'fact', id: 'f1', eventId: 2, kind: 'note', by: 'web-1', at: at(1), text: 'Earlier <note>' }),
    Object.freeze({ type: 'move', eventId: 3, kind: 'claim', by: 'web-1', at: at(5) }),
    Object.freeze({ type: 'fact', id: 'f2', eventId: 4, kind: 'supersession', by: 'coordinator', at: at(6),
      text: 'Correction & replacement', supersedes: 'f1', ref: 'src/file.js:2@abc123' }),
    Object.freeze({ type: 'move', eventId: 5, kind: 'claim', by: 'web-2', at: at(200) }),
  ]);
  const steps = Object.freeze([
    Object.freeze({ from: 'open', move: Object.freeze({ verb: 'add', to: 'open' }), kind: 'add', by: 'web-1', at: at(0) }),
    Object.freeze({ from: 'open', move: Object.freeze({ verb: 'claim', to: 'claimed' }), kind: 'claim', by: 'web-1', at: at(5) }),
    Object.freeze({ from: 'claimed', move: Object.freeze({ verb: 'lapse', to: 'open' }), kind: 'lapse', by: 'the clock', at: null }),
    Object.freeze({ from: 'open', move: Object.freeze({ verb: 'claim', to: 'claimed' }), kind: 'claim', by: 'web-2', at: at(200) }),
  ]);
  const before = JSON.stringify({ entries, steps, flow });
  const present = entry => ({ ...entry, timeLabel: entry.at || '', ageHtml: entry.at ? '<time data-ago="' + entry.at + '">age</time>' : '',
    agentLabel: entry.by === 'the clock' ? entry.by : entry.by + ' (fixture)',
    ...(entry.type === 'fact' ? { hasCodeRef: Boolean(entry.ref), codeHtml: entry.ref ? '<button data-code="' + entry.ref + '">open code</button>' : '' } : {}),
  });
  const html = timelineHtml({ entries: entries.map(present), steps: steps.map(present), flow });
  assert.deepEqual([...html.matchAll(/data-event-id="(\d+)"/gu)].map(match => Number(match[1])), [1, 2, 3, 4, 5]);
  assert.ok(html.indexOf('fact-f1') < html.indexOf('fact-f2') && html.indexOf('fact-f2') < html.lastIndexOf('claim'), 'facts remain in their supplied event positions');
  assert.match(html, /claimed until the lapse, length not logged/u);
  assert.match(html, /open after the lapse, length not logged/u);
  assert.match(html, /tl-superseded/u);
  assert.match(html, /href="#fact-f2">replaced by supersession/u);
  assert.match(html, /data-code="src\/file\.js:2@abc123"/u);
  assert.match(html, /Earlier &lt;note&gt;/u);
  assert.match(html, /Correction &amp; replacement/u);
  assert.equal(JSON.stringify({ entries, steps, flow }), before, 'rendering does not mutate supplied thread or lifecycle observations');
  const malformed = timelineHtml({ flow, steps: [], entries: [{ type: 'fact', id: 'f3', eventId: 6,
    kind: 'note', by: 'web-3', text: 'legacy malformed record', hasCodeRef: true, codeHtml: '',
    timeLabel: 'Invalid Date', ageHtml: '<time data-ago="undefined">NaNd</time>', agentLabel: 'web-3' }] });
  assert.match(malformed, /<time>Invalid Date<\/time>/u, 'a malformed fact keeps the old unconditional time formatting');
  assert.match(malformed, /data-ago="undefined">NaNd<\/time>/u, 'a missing fact time keeps the old age formatter output');
  assert.match(malformed, /<div class="tl-code"><\/div>/u, 'a truthy code reference keeps its wrapper even when formatted code HTML is empty');
});

test('pipeline HTML keeps stage order, oldest arrival, selected item and escaped titles from seeded data [N26,N38,C7]', () => {
  const input = Object.freeze([
    Object.freeze({ id: 9, title: 'Later <ready>', stage: 'open', stageKey: 'ready', stageHtml: '<b>Ready</b>', since: '2026-10-28T12:00:00Z', href: '#item/9', ageHtml: '<time>1m</time>' }),
    Object.freeze({ id: 3, title: 'Earlier & ready', stage: 'open', stageKey: 'gated', stageHtml: '<b>Gated</b>', since: '2026-10-28T11:00:00Z', href: '#item/3', ageHtml: '<time>1h</time>' }),
    ...[['claimed', 'building'], ['submitted', 'in-review'], ['accepted', 'verified'], ['merged', 'merged']].map(([stage, stageKey], index) => Object.freeze({ id: 20 + index, title: stage,
      stage, stageKey, stageHtml: '<b>' + stageKey + '</b>', since: '2026-10-28T12:00:00Z', href: '#item/' + (20 + index), ageHtml: '<time>1m</time>' })),
  ]);
  const html = pipelineHtml(input, { selectedId: 9 });
  assert.deepEqual([...html.matchAll(/data-pipeline-stage="([^"]+)"/gu)].map(match => match[1]), ['gated', 'ready', 'building', 'in-review', 'verified', 'landing', 'merged']);
  assert.deepEqual([...html.matchAll(/data-stage-count="[^"]+">(\d+)/gu)].map(match => Number(match[1])), [1, 1, 1, 1, 1, 0, 1]);
  assert.match(html, /Oldest <a class="ref" href="#item\/3" data-go="item:3">#3<\/a> · <time>1h<\/time>/u);
  assert.ok(html.indexOf('data-item="3"') < html.indexOf('data-item="9"'), 'arrival order determines the stage list');
  assert.match(html, /class="pipeline-item on" type="button" data-item="9"/u);
  assert.match(html, /Later &lt;ready&gt;/u);
  assert.match(html, /Earlier &amp; ready/u);
  assert.equal(pipelineHtml(input, { selectedId: 9 }), html, 'rendering neither sorts the input nor consumes its state');
  const empty = pipelineHtml([]);
  assert.equal((empty.match(/No items/gu) || []).length, 7);
  assert.equal((empty.match(/data-stage-count="[^"]+">0/gu) || []).length, 7);
  assert.ok(!empty.includes('data-item='));
});

test('Needs row adapters retain each call identity and its permitted action from plain data [N26,B26,C7]', () => {
  const revision = { kind: 'spec-revision', id: 'G1', reason: 'Revise the rule' };
  const calls = [{ kind: 'draft', count: 2 }, { kind: 'rigor-draft' }, { kind: 'sentinel-draft' }, { kind: 'agent-approved' },
    revision, { kind: 'decision', id: 7, ref: 'web-1', text: 'Choose <words>', at: 'decision-time' },
    { kind: 'pending', id: 'G2', ref: 'G2', text: 'An open question' },
    { kind: 'block', ref: '#8', text: 'A blocked command', what: 'Resolve it', at: 'block-time' },
    { kind: 'relay-health', ref: 'relay', text: 'Inspect the connection', what: 'Read health', at: 'relay-time' },
    { kind: 'hold', id: 'web', ref: 'web', text: 'Pause building', what: 'A lane hold' }];
  const before = JSON.stringify(calls);
  const rows = needsEntries(calls, [{ hold_lane: 'web', hold_at: 'hold-time' }]);
  assert.equal(rows.length, 6, 'draft and approval surfaces are not duplicated as legacy rows');
  assert.deepEqual(rows[0], { revision });
  assert.deepEqual(rows[1], ['decide:7', 'web-1', 'Choose <words>', 'decide', 'decision-time']);
  assert.deepEqual(rows[2], ['spec:G2', 'G2', 'An open question', 'answer G2']);
  assert.equal(rows[5][4], 'hold-time', 'a lane call retains the supplied hold instant');
  const seen = [];
  const render = (entry, context, action) => { seen.push({ entry, context, action }); return action; };
  assert.deepEqual(rows.map(row => renderNeedsRow(render, row => 'revision:' + row.id, row)),
    ['revision:G1', 'decide', 'answer', 'next step', 'inspect', 'release']);
  assert.equal(seen[0].entry[1], '', 'the decision author is context, not a duplicate row label');
  assert.equal(seen[0].context, 'a decision, asked by web-1');
  assert.equal(seen[1].context, 'an open question in SPEC.md');
  assert.equal(JSON.stringify(calls), before, 'adapting and rendering do not consume input calls');
});

test('render logic receives its clock and the source policy refuses ambient clock or global acquisition [N26,C7]', () => {
  assert.throws(() => dashboardModel({}, []), /explicit clock reading/u);
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(dashboardModel({}, [], { now }).now, now);
  const idle = { cause: 'IDLE_AGENT', owner: 'web-1', since: '2026-10-28T11:23:00Z',
    why: 'web-1 has held no claim while #2 waits in web', next: 'take #2' };
  assert.match(activityWords(idle, { now }).text, /idle for 37 minutes/u);
  assert.equal(activityWords(idle).text, idle.why, 'an absent clock cannot invent elapsed idle time');
  const root = 'test/cockpit/purity-control.test.js';
  const report = source => viewTestProblems({ sources: new Map([[root, source]]), edges: new Map([[root, []]]),
    roots: [root], roles: { [root]: { kind: 'logic', reason: 'A source-only policy control' } }, coverage: [] });
  for (const source of ["global.process.getBuiltinModule('node:fs')['readFileSync']('file')", 'Date.now()', 'new Date()']) {
    assert.ok(report(source).length > 0, source + ' must be a named purity violation');
  }
  assert.deepEqual(report("const input = 'global.process and Date.now()'; new Date(123);"), [], 'quoted text and supplied date values are data');
  assert.deepEqual(report('const summary = { window: 2, document: 3 }; summary.window; summary?.document;'), [],
    'object keys and member names describe supplied data');
  for (const source of ['({ window })', 'condition ? window : other', '({ ...window })', '({ [window]: 1 })', 'window.document']) {
    assert.ok(report(source).some(problem => problem.text.includes('ambient execution/DOM port window')),
      source + ' still reads the ambient binding');
  }
});

test('Needs HTML keeps grouped calls, exact confirmation identities and compact overflow without a browser [N26,B26,C7]', () => {
  const at = '2026-10-28T12:00:00Z';
  const approvals = [1, 2, 3, 4].map(n => ({ kind: 'agent-approved', id: 'G' + n, approvedAt: at,
    actions: [{ verb: 'spec-approve', args: { ids: 'G' + n } }] }));
  const calls = [{ kind: 'decision', id: 7, ref: 'web-1', text: 'Choose <words> & keep the full question.', at },
    { kind: 'sentinel-draft', id: 'watch', ref: 'watch', check: 'node check.js', every: 'hourly', owner: 'coordinator', directory: '.' },
    ...approvals, { kind: 'draft', count: 2 }];
  const project = { holds: [], spec: approvals.map(row => ({ id: row.id, text: row.id + ' <full requirement>', gate: 'gate ' + row.id,
    agentApproval: { agent: 'core-1', approvedAt: at, commit: 'a'.repeat(40) } })) };
  const before = JSON.stringify({ calls, project });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const localDateLabel = value => value === at ? 'Prepared approval date' : 'Date unknown';
  const present = model => new Map([...model.questions,...model.approvals].map(row => [row.key, {
    ageHtml: row.ageAt ? '<time data-ago="' + row.ageAt + '">2m</time>' : '',
    bodyHtml: row.body ? escape(row.body) : '',
    approvalDateLabel: Number.isFinite(Date.parse(row.fields.find(([label]) => label === 'Approved in Git')?.[3]?.date))
      ? localDateLabel(row.fields.find(([label]) => label === 'Approved in Git')[3].date) : 'Date unknown',
  }]));
  const options = { person: true, expanded: ['agent-approved:G1'] };
  const model = needsPanelModel(calls, project, options), presentation = present(model);
  const html = needsPanelHtml(model, presentation);
  assert.match(html, /Questions and sentinels · 2/u);
  assert.match(html, /Rows approved in Git, waiting for you · 4/u);
  assert.match(html, /data-needs-confirm="G1 G2 G3 G4">Confirm all 4/u);
  assert.match(html, /data-needs-key="agent-approved:G1"[^>]* open/u);
  assert.match(html, /G1 &lt;full requirement&gt;/u);
  assert.match(html, /Prepared approval date<\/time>/u);
  assert.match(html, /Choose &lt;words&gt; &amp; keep the full question\./u);
  assert.match(html, /<time data-ago="2026-10-28T12:00:00Z">2m<\/time>/u);
  assert.match(html, new RegExp('title="' + 'a'.repeat(40) + '">aaaaaaaaaaaa</code>', 'u'));
  assert.match(html, /2 draft spec rows to approve or drop/u);
  const compactModel = needsPanelModel(calls, project, { ...options, compact: true });
  const compact = needsPanelHtml(compactModel, present(compactModel));
  assert.equal((compact.match(/<li class="needs-call /gu) || []).length, 3);
  assert.match(compact, /3 more and 2 draft rows in Needs you/u);
  assert.doesNotMatch(needsPanelHtml(needsPanelModel(calls, project)), /data-needs-confirm=/u, 'read-only presentation advertises no bulk confirmation');
  const readOnly = needsPanelHtml(needsPanelModel(calls, project));
  assert.doesNotMatch(readOnly, /data-go=/u, 'read-only draft summaries contain no navigation controls');
  const copyControls = [...readOnly.matchAll(/<button\b[^>]*>/gu)];
  assert.equal(copyControls.length, 4, 'each approved row retains its copy control in read-only summaries');
  for (const [control] of copyControls) {
    assert.match(control, /class="hash-copy" type="button"/u, 'read-only summaries allow only hash-copy buttons');
    assert.match(control, new RegExp('title="' + 'a'.repeat(40) + '"', 'u'));
    assert.match(control, new RegExp('data-copy="' + 'a'.repeat(40) + '"', 'u'));
  }
  assert.match(html, /needs-drafts"><button type="button" data-go="tab:spec">/u, 'normal draft summaries retain their Spec navigation');
  const invalidAction = structuredClone(calls);
  invalidAction.find(row => row.id === 'G4').actions[0].args.ids = 'G1';
  const invalidModel = needsPanelModel(invalidAction, project, options);
  assert.match(needsPanelHtml(invalidModel, present(invalidModel)), /data-needs-confirm="G1 G2 G3">Confirm all 3/u);
  const declineOnly = structuredClone(calls);
  for (const row of declineOnly.filter(row => row.kind === 'agent-approved')) row.actions = [{ verb: 'spec-decline', args: { ids: row.id } }];
  assert.doesNotMatch(needsPanelHtml(needsPanelModel(declineOnly, project, options)), /data-needs-confirm=/u);
  assert.equal(JSON.stringify({ calls, project }), before, 'sorting, expansion and confirmation do not rewrite supplied calls');
  const hiddenCommand = { kind: 'block', id: 'refused-secret-command', ref: '#8', text: 'A blocked command', what: 'Resolve it', at };
  const blockModel = needsPanelModel([hiddenCommand], { holds: [] });
  const publicBlock = needsPanelHtml(blockModel, present(blockModel));
  assert.match(publicBlock, /data-needs-key="block:#8:/u);
  assert.doesNotMatch(publicBlock, /refused-secret-command/u, 'block identity uses only its public reference and time');
  assert.equal(needsPanelHtml(needsPanelModel([], { holds: [] })), '');
});

test('Home rule HTML counts approved rows and gate declarations without implying execution [N26,C7]', () => {
  const rows = Object.freeze([{ status: 'approved', gate: 'node check.js' }, { status: 'approved', gate: 'none' },
    { status: 'approved', gate: '  ' }, { status: 'draft', gate: 'node draft.js' }, { status: 'wont', gate: 'node retired.js' }]);
  const html = homeRules(rows);
  assert.match(html, /data-home-count="approved"><dt>Approved<\/dt><dd>3<\/dd>/u);
  assert.match(html, /data-home-count="gated"><dt>Name a gate<\/dt><dd>2<\/dd>/u);
  assert.match(html, /data-home-count="ungated"><dt>No gate<\/dt><dd>1<\/dd>/u);
  assert.match(html, /data-go="tab:spec"/u);
  assert.doesNotMatch(html, /passed|failed|node check/u, 'the card reports declarations, not made-up gate results');
  assert.match(homeRules(null), /<dd>0<\/dd>/u);
});

test('Roadmap headers display supplied counts, estimates and linked needs without deriving a board [N26,C7]', () => {
  const summary = { total: 10, left: 8, landed: 2, landing: 1, review: 3, building: 1, waiting: 2, held: 1,
    estimate: { low: 2, high: 4 }, pace: { last6h: 2, last2h: 1 }, window: '6h', needsYou: [7, 'other#8'] };
  const milestone = { name: '0.9 <release>', target: '2026-10-29T12:00:00Z', pastTarget: true, summary };
  const page = { root: '/local', held: milestone.name, targetLabels: new Map(), addresses: new Map(),
    now: Date.parse('2026-10-28T12:00:00Z'), locale: 'en-US', timeZone: 'UTC' };
  const read = { milestone, rows: [{ label: '#7', title: 'Local <need>', open: { id: 7, root: '/local' } },
    { label: 'other#8', title: 'Remote & need', open: { id: 8, root: '/other' } }] };
  page.targetLabels.set(read, 'display:' + milestone.target);
  for (const row of read.rows) page.addresses.set(row, row.open.root + '/item/' + row.open.id);
  const headers = roadmapHeaders(page);
  const result = headers(read);
  assert.equal(headers(read), result, 'all surfaces reuse one header for the same immutable read');
  assert.equal(headers(null), null);
  assert.match(result.count, /8 to go/u);
  assert.match(result.top.replace(/<[^>]*>/gu, ''), /0\.3 items an hour · 2 landed in the last 6 h, 1 in the last 2 h · done in about 3 hours, Wednesday afternoon/u);
  assert.match(result.detail, /viewBox="0 0 10 1"/u);
  assert.deepEqual([...result.detail.matchAll(/data-count="(\d+)"/gu)].map(match => Number(match[1])), [2, 1, 3, 1, 2, 1]);
  assert.match(result.detail, /aria-pressed="true" data-summary-state="held"/u);
  assert.match(result.detail, /display:2026-10-29T12:00:00Z/u);
  assert.match(result.detail, /past target/u);
  assert.match(result.detail, /href="\/other\/item\/8" data-go="item:8" data-board="\/other"/u);
  assert.match(result.detail, /Local &lt;need&gt;/u);
  assert.match(result.detail, /Remote &amp; need/u);
  const replaced = { milestone, rows: [{ label: '#7', title: 'Replacement board', open: { id: 7, root: '/replacement' } }] };
  page.addresses.set(replaced.rows[0], '/replacement/item/7');
  assert.match(headers(replaced).detail, /href="\/replacement\/item\/7" data-go="item:7" data-board="\/replacement"/u,
    'a new read identity cannot reuse a header from a different board');
  assert.match(headers(replaced).detail, /<span>#other#8<\/span>/u, 'an unresolved need retains its original fallback');
  assert.equal(roadmapSummary({ ...milestone, summary: { ...summary, left: 0 } }), null);
  assert.equal(roadmapSummary({ ...milestone, summary: { ...summary, held: -1 } }), null);
  const unknown = roadmapSummary({ ...milestone, summary: { ...summary, estimate: null, reason: 'few-landings' } });
  assert.match(unknown.top, /too few landings yet to estimate/u);
  assert.doesNotMatch(unknown.top, /done in about 0/u);
});

test('Roadmap item HTML retains blockers, provenance and escaped detail from explicit display inputs [N26,C7]', () => {
  const item = { id: 7, lane: 'web', status: 'open', blockedBy: [8], criterion: 'Keep <all> words. A second sentence.',
    builtBy: 'web-1', verifiedBy: 'tests-1', specs: ['G1'], verdict: { decision: 'REJECT', reason: 'TEST_FAILURE',
      note: 'TEST_FAILURE: First <reason>. More detail.', by: 'tests-1', at: 'rejected-at' },
    history: [{ kind: 'add', at: 'added-at' }, { kind: 'claim', at: 'claimed-at' }, { kind: 'claim', at: 'again-at' }] };
  const context = { items: [{ id: 8, status: 'claimed', claim: { by: 'web-2' }, since: 'held-at' },
    { id: 9, status: 'open', blockedBy: [7] }], holds: [{ hold_lane: 'web', hold_reason: 'Check <lane>' }],
    itemHolds: [{ item: 7, reason: 'Keep <pause>' }],
    times: new Map(['held-at', 'rejected-at', 'added-at', 'claimed-at', 'again-at'].map(at => [at, 'display:' + at])),
    names: new Map(['web-1', 'web-2', 'tests-1'].map(id => [id, '<' + id + '>'])),
    states: new Map([[8, 'building'], [9, 'open']]), releases: ['0.9 <release>'], address: '/item/7', board: '/other' };
  const before = structuredClone({ item, context });
  const result = roadmapBlock(item, context);
  assert.match(result.label, /waits on #8 \(claimed\).*held: Keep <pause>.*lane web held/u);
  assert.match(result.dot, /Keep &lt;pause&gt;/u);
  assert.match(result.detail, /Keep &lt;all&gt; words\./u);
  assert.doesNotMatch(result.detail, /A second sentence/u);
  assert.match(result.detail, /&lt;web-2&gt;/u);
  assert.match(result.detail, /#9 unclaimed/u);
  assert.match(result.detail, /First &lt;reason&gt;\.\u2026/u);
  assert.match(result.detail, /claimed again/u);
  assert.match(result.detail, /display:rejected-at/u);
  assert.match(result.detail, /href="\/item\/7" data-go="item:7" data-board="\/other"/u);
  assert.equal(roadmapBlock(item, { ...context, summaryOnly: true }).detail, '');
  assert.match(roadmapBlock(item, { ...context, loading: true }).detail, /Loading detail/u);
  assert.match(roadmapBlock(item, { ...context, error: '<unavailable>' }).detail, /&lt;unavailable&gt;/u);
  assert.equal(roadmapBlock(null), null);
  assert.deepEqual({ item, context }, before);
});

test('timeline references keep URLs and absolute paths as literal prose [N26,B23]', () => {
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  const literals = [
    ['https://example.test/src/example.js#958', 'https://example.test/src/example.js#958'],
    ['https://example.test/' + sha + '?code=ONE_CLAIM&item=958', 'https://example.test/' + sha + '?code=ONE_CLAIM&amp;item=958'],
    ['file:///Users/person/src/example.js#958', 'file:///Users/person/src/example.js#958'],
    ['/Users/person/src/example.js:2@' + sha, '/Users/person/src/example.js:2@' + sha],
    ['~/project/src/example.js', '~/project/src/example.js'],
    ['C:/Users/person/src/example.js', 'C:/Users/person/src/example.js'],
    ['C:\\Users\\person\\ONE_CLAIM#958', 'C:\\Users\\person\\ONE_CLAIM#958'],
  ];
  for (const [literal, escaped] of literals) {
    const links = [];
    const html = timelineBodyHtml('Before (' + literal + ') after', { commit: sha,
      itemHref: id => { links.push(['item', id]); return '/items/' + id; },
      codeLink: ref => { links.push(['code', ref]); return '<button>code</button>'; } });
    assert.equal(html, 'Before (' + escaped + ') after', 'the complete external reference remains escaped literal text');
    assert.deepEqual(links, [], 'neither URL fragments nor absolute paths invoke repository navigation');
  }
});

test('timeline prose ratios and diff prefixes stay text while a hash beside a slash stays a hash [N26,B23]', () => {
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  const refs = [];
  const text = `2/2 Items24/25 clamp/words/grouping/references a/test/cockpit/agents.test.js ${sha}/tree${sha}`;
  const html = timelineBodyHtml(text, { commit: sha,
    codeLink: ref => { refs.push(ref); return '<button data-code="' + ref + '">code</button>'; } });
  assert.deepEqual(refs, [], 'slash-separated prose and diff prefixes name no repository file');
  assert.ok(html.startsWith('2/2 Items24/25 clamp/words/grouping/references a/test/cockpit/agents.test.js '), 'original prose stays intact');
  assert.ok(html.includes('data-copy="' + sha + '"><code class="inline sha" title="' + sha + '">' + sha.slice(0, 12) + '</code></button>/tree' + sha), 'a commit followed by a slash retains its copyable hash chip');
});

test('timeline text keeps quoted words, escapes markup and binds only detected references [N26,B23]', () => {
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  const text = `A <script>ONE_CLAIM</script> says #2; src/example.js:2@${sha}; README.md:1@${sha}; ${sha}; 2026-10-28T12:34:56Z. ../outside.js stays text.`;
  const refs = [];
  const html = timelineBodyHtml(text, { itemHref: id => '#items/' + id,
    codeLink: ref => { refs.push(ref); return '<button data-code="' + ref + '">code</button>'; },
    timeLabel: () => '7:34 AM', refusalTitles: { ONE_CLAIM: 'Finish or release the current claim.' } });
  assert.match(html, /&lt;script&gt;/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /data-go="item:2" href="#items\/2"/u);
  assert.deepEqual(refs, ['src/example.js:2@' + sha, 'README.md:1@' + sha]);
  assert.match(html, /title="Finish or release the current claim\."/u);
  assert.match(html, new RegExp('title="' + sha + '" aria-label="Copy full hash ' + sha + '" data-copy="' + sha + '"><code class="inline sha" title="' + sha + '">abcdef123456</code></button>'));
  assert.match(html, />7:34 AM<\/time>/u);
  assert.match(html, /\.\.\/outside\.js stays text\./u);
  const at = '2026-10-28T12:00:00Z';
  const moves = [1, 2].map(eventId => ({ type: 'move', eventId, kind: 'proof-run', by: 'web-1', at }));
  const steps = moves.map(entry => ({ ...entry, from: 'claimed', move: null, model: 'Actual model', timeLabel: '7:00 AM' }));
  const flow = { initial: 'open', states: [{ id: 'claimed', final: false }] };
  const htmlPair = timelineHtml({ entries: moves, steps, flow });
  assert.match(htmlPair, /ran the proof twice/u);
  assert.match(htmlPair, /data-event-ids="1 2"/u);
  assert.match(htmlPair, /title="Actual model">web-1/u);
  assert.equal((htmlPair.match(/class="tl-claimed/g) ?? []).length, 1);
  const separated = timelineHtml({ entries: [moves[0], { type: 'fact', id: 'note', eventId: 3, by: 'web-1', kind: 'note', text: 'Between proofs' }, moves[1]], steps, flow });
  assert.doesNotMatch(separated, /ran the proof twice/u, 'a note prevents grouping non-consecutive moves');
  const renewals = moves.map(entry => ({ ...entry, kind: 'renew' }));
  const renewSteps = steps.map(entry => ({ ...entry, kind: 'renew', move: { verb: 'renew', to: 'claimed' } }));
  const renewed = timelineHtml({ entries: renewals, steps: renewSteps, flow });
  assert.match(renewed, /continued building twice/u, 'identical native self loops group too');
  assert.match(renewed, /data-event-ids="1 2"/u);
});
