/** Activity model and HTML assertions use plain input; the real Chrome wiring lives in activity-journey.test.js [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityModel } from '../../../../src/logic/activity/model.js';
import { activityFilters } from '../../../../src/logic/activity/render.js';
import { activityHtml } from '../../../../src/logic/activity/render.js';
import { activityWords } from '../../../../src/logic/activity/words.js';
import { now } from '../../../../../cli/tests/fixtures/cockpit/activity.js';
import { at } from '../../../../../cli/tests/fixtures/cockpit/activity.js';
import { items } from '../../../../../cli/tests/fixtures/cockpit/activity.js';
import { agents } from '../../../../../cli/tests/fixtures/cockpit/activity.js';
import { event } from '../../../../../cli/tests/fixtures/cockpit/activity.js';
import { scannedBoard } from '../../../../../cli/tests/fixtures/cockpit/activity.js';

/** Prepare deterministic UTC test presentation; production retains browser-local labels. */
const escape = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const activityTime = value => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
const collectTimes = (labels, text) => {
  for (const match of String(text ?? '').matchAll(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/gu))
    if (!labels.has(match[0])) labels.set(match[0], Number.isFinite(Date.parse(match[0])) ? activityTime(match[0]) : match[0]);
};
const localTimes = (text, labels) => String(text ?? '').replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/gu,
  value => Number.isFinite(Date.parse(value)) ? labels.get(value) ?? value : value);
const prepare = (model, { itemAddress = id => '#item/' + id } = {}) => {
  const labels = new Map();
  for (const entry of model.rows) {
    collectTimes(labels, entry.words);
    for (const finding of [...(entry.findings || []), ...(entry.stillStuck || [])]) {
      for (const value of Object.values(finding)) if (typeof value === 'string') collectTimes(labels, value);
      if (Number.isFinite(Date.parse(finding.since))) labels.set(finding.since, activityTime(finding.since));
    }
  }
  return { ...model, rows: model.rows.map(entry => {
    const prepareFinding = finding => ({ ...finding, words: activityWords(finding, { now: Date.parse(entry.at), timestampLabels: labels }) });
    return { ...entry, timeLabel: activityTime(entry.at), dayKey: new Date(entry.at).toISOString().slice(0, 10),
      dayLabel: new Date(entry.at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      itemHref: entry.item ? itemAddress(entry.item.id) : null,
      quoteHtml: entry.kind === 'shout' && entry.words ? escape(localTimes(entry.words, labels)) : '',
      findings: entry.findings?.map(prepareFinding), stillStuck: entry.stillStuck?.map(prepareFinding) };
  }) };
};
const render = (data, options = {}) => activityHtml(prepare(activityModel({ items, agents, ...data })), options);

test('Activity questions keep their item as a quiet inline link without changing native words [N26]', () => {
  const data = { items, agents,
    shouts: [{ shout_id: 20, shout_from: 'view-1', shout_to: 'coordinator', shout_decision: 1, shout_text: 'Keep <these words> about #1?' }],
    events: [event(20, 'shout', { item: 1, detail: { shout: 20, decision: true } })] };
  const model = activityModel(data);
  assert.equal(model.rows[0].verb, 'asked');
  assert.equal(model.rows[0].item.id, 1);
  const html = activityHtml(prepare(model, { itemAddress: id => '/board/items/' + id }));
  assert.match(html, /asked the coordinator[^]*?<a class="activity-about ref" href="\/board\/items\/1" data-go="item:1">about #1<\/a><\/p>/u);
  assert.match(html, /Keep &lt;these words&gt; about #1\?/u);
  assert.doesNotMatch(html, /<span class="activity-item"/u, 'the shout has no duplicate work-item title underneath');
});

test('Activity related items prefer native context and otherwise only resolve actual mentioned items [N26]', () => {
  const shouts = [
    { shout_id: 1, shout_to: 'item:2', shout_text: 'A scoped question about #1?' },
    { shout_id: 2, shout_to: 'coordinator', shout_text: 'Unknown #999 first, then actual #1.' },
    { shout_id: 3, shout_to: 'coordinator', shout_text: 'Only unknown #999.' },
    { shout_id: 4, shout_to: 'coordinator', shout_text: 'Can this proceed?', shout_evidence_item: 2 },
  ];
  const model = activityModel({ items, agents, shouts, events: shouts.map(row => event(row.shout_id, 'shout', { item: null, detail: { shout: row.shout_id } })) });
  const byId = new Map(model.rows.map(row => [row.id, row]));
  assert.equal(byId.get(1).item?.id, 2);
  assert.equal(byId.get(1).verb, 'asked');
  assert.equal(byId.get(2).item?.id, 1);
  assert.equal(byId.get(2).verb, 'told');
  assert.equal(byId.get(3).item, null);
  assert.equal(byId.get(4).item?.id, 2);
  assert.equal(byId.get(4).verb, 'asked');
});

for (const [kind, verb] of Object.entries({ claim: 'started building', release: 'let go of', fact: 'added a note', note: 'added a note',
  'proof-run': 'ran the proof', reserve: 'started reviewing', accept: 'passed', reject: 'sent back', reopen: 'sent back' })) {
  test(`Activity ${kind} reads as ${verb}, with its item underneath [N26]`, () => {
    const html = render({ events: [event(1, kind)] });
    assert.match(html, new RegExp(`title="Test Model">view-1</span> ${verb}</p><span class="activity-item"`, 'u'));
    assert.match(html, /data-go="item:1">#1<\/a>First &lt;item&gt;/u);
    assert.match(html, /<time>\d{1,2}:\d\d [AP]M<\/time>/u);
    assert.doesNotMatch(html, /\(unknown\)|2026-10-28T/u);
    assert.match(html, /class="activity-verb [^"]+"><svg/u);
  });
}

test('Activity item links retain the supplied board-scoped address [N26]', () => {
  const model = activityModel({ items, agents, events: [event(1, 'claim')] });
  const html = activityHtml(prepare(model, { itemAddress: () => '/board/project%20one/items/1?tab=activity&from=feed' }));
  assert.match(html, /href="\/board\/project%20one\/items\/1\?tab=activity&amp;from=feed" data-go="item:1"/u);
});

test('Activity presentation groups explicit UTC days without mutating the model [N26]', () => {
  const model = activityModel({ items, agents, events: [event(20, 'fact', { minutes: 252 }), event(21, 'fact', { minutes: 253 })] });
  const before = JSON.stringify(model);
  const html = activityHtml(prepare(model));
  assert.match(html, /<h4 class="day">Wed, Oct 28<\/h4>[\s\S]*<h4 class="day">Tue, Oct 27<\/h4>/u);
  assert.equal([...html.matchAll(/<li class="activity-day">/gu)].length, 2);
  assert.equal(JSON.stringify(model), before, 'preparing presentation leaves model input unchanged');
});

test('a release and claim by one seat in the same minute form one handoff sentence, in either event order [N26]', () => {
  for (const reverse of [false, true]) {
    const events = [event(1, reverse ? 'claim' : 'release', { item: reverse ? 2 : 1, minutes: 1 }), event(2, reverse ? 'release' : 'claim', { item: reverse ? 1 : 2, minutes: 1 })];
    const model = activityModel({ items, agents, events });
    assert.equal(model.rows.length, 1);
    assert.equal(model.counts.work, 1);
    assert.match(activityHtml(prepare(model)), /let go of <b>#1<\/b> and started building <b>#2<\/b>/u);
  }
  assert.equal(activityModel({ items, agents, events: [event(1, 'release', { minutes: 2 }), event(2, 'claim', { item: 2, minutes: 1 })] }).rows.length, 2, 'different minutes do not merge');
  assert.equal(activityModel({ items, agents, events: [event(1, 'release', { minutes: 1, by: 'other-1' }), event(2, 'claim', { item: 2, minutes: 1 })] }).rows.length, 2, 'different seats do not merge');
});

test('a native sentinel scan is one collapsed disclosure, deduplicates addressed notices and retains its next step [N26]', () => {
  const data = scannedBoard(), model = activityModel(data);
  assert.deepEqual(model.counts, { all: 2, work: 0, sentinels: 1, shouts: 1 });
  const run = model.rows.find(row => row.kind === 'sentinels');
  assert.equal(run.findings.length, 1, 'two deliveries plus their health event describe one finding');
  assert.equal(run.heldBack, 8);
  const collapsed = activityHtml(prepare(model));
  assert.match(collapsed, /<details class="activity-run" data-activity-run="sentinels:5"><summary>/u);
  assert.match(collapsed, /Sentinels<\/b> checked the board/u);
  assert.match(collapsed, /view-1 holds #1 while #2 ranks above it and sits free/u);
  assert.match(collapsed, /Next: release #1, then claim #2/u);
  assert.doesNotMatch(collapsed, /\[RANK_INVERSION\]|health-scan|activity-delivered|flake-observation/u);
  assert.match(activityHtml(prepare(model), { open: [run.id] }), /data-activity-run="sentinels:5" open/u);
  const dateOnly = structuredClone(model);
  dateOnly.rows.find(row => row.kind === 'sentinels').findings[0].since = '2026-10-28';
  assert.match(activityHtml(prepare(dateOnly)), /since 12:00 AM/u,
    'a valid date-only since value retains its prepared time label');
});

test('resolved and still-stuck findings stay in their own run, with all filter counts [N26]', () => {
  const data = scannedBoard();
  data.events.push(event(9, 'health-resolved', { by: 'sentinel', detail: { key: data.finding.key, cause: 'refusal:RANK_INVERSION', since: data.finding.since, subject: '#1' } }),
    event(10, 'health-scan', { item: null, by: 'coordinator', detail: { active: [] } }), event(11, 'fact'));
  const model = activityModel(data);
  assert.deepEqual(model.counts, { all: 4, work: 1, sentinels: 2, shouts: 1 });
  const html = activityHtml(prepare(model));
  assert.match(html, /1 resolved/u);
  for (const [filter, count] of Object.entries(model.counts)) {
    const filtered = activityHtml(prepare(model), { filter });
    assert.equal([...filtered.matchAll(/<li class="activity-event"/gu)].length, count);
    assert.match(filtered, new RegExp(`data-activity-filter="${filter}" aria-pressed="true" class="on">[^<]+<b>${count}</b>`, 'u'));
  }
});

test('shouts preserve all their own words, quoted markup and lines; only machine timestamps become clock times [N26]', () => {
  const html = render(scannedBoard(), { filter: 'shouts' });
  assert.match(html, /view-1<\/span> told the coordinator/u);
  assert.match(html, /Keep \[MY_CODE\] and &lt;these words&gt;\.\nNext appointment: \d{1,2}:\d\d [AP]M/u);
  assert.doesNotMatch(html, /2026-10-28T|\(unknown\)/u);
});

test('sentinel words cover rank, elapsed idle time, withdrawn dependencies and unknown future codes without code tokens [N26]', () => {
  const labels = new Map([[at(37), activityTime(at(37))]]);
  const idle = activityWords({ cause: 'IDLE_AGENT', owner: 'view-1', since: at(37), why: 'view-1 has held no claim or review and pulled nothing for 30 minutes, while #2 waits in view and it could take it', next: 'take #2' }, { now, timestampLabels: labels });
  assert.match(idle.text, /idle for 37 minutes while #2 waits in its view lane/u);
  for (const cause of ['AFTER_WITHDRAWN', 'UNPAIRED_WORK', 'CONFLICT_HOLD_CLEARS', 'A_FUTURE_CODE']) {
    const next = 'inspect [A_FUTURE_CODE] at ' + at(1), timestampLabels = new Map([[at(1), activityTime(at(1))], [at(2), activityTime(at(2))]]);
    const text = activityWords({ cause, subject: '#1', next, since: at(2) }, { timestampLabels });
    assert.doesNotMatch(JSON.stringify(text), /\[[A-Z_]+\]|2026-10-28T/u);
    assert.ok(text.text.length > 4);
  }
});

/** Event-shaped coverage only; this fixture is not a native scan or execution receipt. */
test('an idle sentinel finding measures from its containing scan time [N26]', () => {
  const since = at(42), scan = event(12, 'health-scan', { item: null, by: 'coordinator', minutes: 5,
    detail: { active: [{ key: 'IDLE_AGENT:view-1', cause: 'IDLE_AGENT', owner: 'view-1', subject: 'view-1', since,
      why: 'view-1 has held no claim or review and pulled nothing, while #2 waits in view and it could take it', next: 'take #2' }] } });
  const html = render({ events: [scan] });
  assert.match(html, /view-1 has been idle for 37 minutes while #2 waits in its view lane/u);
});

test('Activity omits absent and unknown model hover titles and retains a known model [N26]', () => {
  for (const metadata of [{}, { model: '' }, { model: 'unknown' }, { agent_model: 'unknown' }, { model: ' UNKNOWN ' }]) {
    const html = render({ agents: [{ agent_id: 'coordinator', ...metadata }], events: [event(1, 'fact', { by: 'coordinator' })] });
    assert.match(html, /<span class="activity-who">The coordinator<\/span>/u);
    assert.doesNotMatch(html, /title="unknown"|title=" UNKNOWN "/u);
  }
  const known = render({ agents: [{ agent_id: 'view-1', model: '<Known & model>' }], events: [event(1, 'fact')] });
  assert.match(known, /class="activity-who" title="&lt;Known &amp; model&gt;">view-1/u);
});

test('sentinel rejection reasons become words while the reviewer note keeps its own code text [N26]', () => {
  const reasons = { TEST_FAILURE: 'Tests failed', BEHAVIOR_MISMATCH: 'Behavior did not match', INSUFFICIENT_EVIDENCE: 'Not enough evidence', STALE_HEAD: 'Source changed', OTHER: 'Other reason', FUTURE_REASON: 'future reason' };
  const note = 'Keep [MY_CODE] and (TEST_FAILURE) exactly; quoted words are evidence.';
  for (const [reason, label] of Object.entries(reasons)) {
    const finding = { key: 'REWORK_UNCLAIMED:1', cause: 'refusal:REWORK_UNCLAIMED', subject: '#1', since: at(4),
      why: 'rejected by core-728 (' + reason + '): ' + note + '; its builder is not live', next: 'Inspect [' + reason + ']' };
    const html = render({ events: [
      event(1, 'health-failure', { by: 'sentinel', detail: finding }),
      event(2, 'health-scan', { item: null, by: 'coordinator', detail: { active: [finding] } }),
    ] }, { open: ['sentinels:2'] });
    assert.ok(html.includes('rejected by core-728 (' + label + '): ' + note), reason + ' is translated only in the native prefix');
    assert.ok(html.includes('Next: Inspect ' + label), 'machine guidance uses the same reason words');
    assert.ok(!html.includes('rejected by core-728 (' + reason + '):'), 'raw rejection reason does not leak from the machine prefix');
  }
});

test('Activity filters keep explicit counts and the feed can omit duplicated controls [N26,C7]', () => {
  const model = { rows: [], counts: { all: 9, work: 4, sentinels: 2, shouts: 3 } };
  const html = activityFilters(model, 'shouts');
  assert.match(html, /data-activity-filter="shouts"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-activity-filter="shouts"/u);
  for (const count of [9, 4, 2, 3]) assert.ok(html.includes('<b>' + count + '</b>'));
  assert.doesNotMatch(activityHtml(model, { controls: false }), /data-activity-filter=/u);
  assert.match(activityHtml(model, { controls: false }), /No activity matches/u);
});
