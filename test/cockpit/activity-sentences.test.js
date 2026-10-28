/** @pullboard-test-gui */
/** Approved Activity sentences over native event envelopes and a live real-board Chrome journey [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { applyRelayMove, appliedSequence, prepareEngineMove } from '../../src/engine.js';
import { activityModel } from '../../src/view/activity-model.js';
import { activityHtml } from '../../src/view/activity-render.js';
import { activityWords } from '../../src/view/activity-words.js';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press, proofShot } from './fixture.js';

const now = Date.parse('2026-10-28T04:12:00Z');
const at = minutes => new Date(now - minutes * 60_000).toISOString();
const items = [{ id: 1, title: 'First <item> with a deliberately long title to ellipsize' }, { id: 2, title: 'Second item' }];
const agents = [{ agent_id: 'view-1', model: 'Test Model' }];
const event = (id, kind, { item = 1, by = 'view-1', minutes = id, detail = {} } = {}) => ({ event_id: id, event_kind: kind, item_id: item, event_by: by, event_at: at(minutes), event_detail: JSON.stringify(detail) });
const render = (data, options = {}) => activityHtml(activityModel({ items, agents, ...data }), { words: activityWords, ...options });

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

test('a release and claim by one seat in the same minute form one handoff sentence, in either event order [N26]', () => {
  for (const reverse of [false, true]) {
    const events = [event(1, reverse ? 'claim' : 'release', { item: reverse ? 2 : 1, minutes: 1 }), event(2, reverse ? 'release' : 'claim', { item: reverse ? 1 : 2, minutes: 1 })];
    const model = activityModel({ items, agents, events });
    assert.equal(model.rows.length, 1);
    assert.equal(model.counts.work, 1);
    assert.match(activityHtml(model, { words: activityWords }), /let go of <b>#1<\/b> and started building <b>#2<\/b>/u);
  }
  assert.equal(activityModel({ items, agents, events: [event(1, 'release', { minutes: 2 }), event(2, 'claim', { item: 2, minutes: 1 })] }).rows.length, 2, 'different minutes do not merge');
  assert.equal(activityModel({ items, agents, events: [event(1, 'release', { minutes: 1, by: 'other-1' }), event(2, 'claim', { item: 2, minutes: 1 })] }).rows.length, 2, 'different seats do not merge');
});

/** Native deliverHealthNotices emits two addressed shouts and one health event before its closing scan. */
function scannedBoard() {
  const finding = { key: 'RANK_INVERSION:item:1', cause: 'RANK_INVERSION', item: 1, subject: '#1', title: 'a free item ranks ahead', since: at(11),
    why: 'view-1 claimed #1 while #2 ranks ahead in the view lane and sits free', owner: 'view-1', next: 'release #1, then claim #2' };
  const notice = `Stuck: #1 a free item ranks ahead [RANK_INVERSION], since ${finding.since}. ${finding.why}. Owner: view-1. Next: ${finding.next}.`;
  const shouts = [{ shout_id: 1, shout_from: 'sentinel', shout_to: 'view-1', shout_text: notice }, { shout_id: 2, shout_from: 'sentinel', shout_to: 'coordinator', shout_text: notice },
    { shout_id: 3, shout_from: 'sentinel', shout_to: 'coordinator', shout_text: 'Health: 8 more notices from this run were held back, so one run never floods a feed; pullboard health lists every finding.' },
    { shout_id: 4, shout_from: 'view-1', shout_to: 'coordinator', shout_text: 'Keep [MY_CODE] and <these words>.\nNext appointment: 2026-10-28T04:12:00Z' }];
  const events = [event(1, 'shout', { by: 'sentinel', item: null, detail: { shout: 1 } }), event(2, 'shout', { by: 'sentinel', item: null, detail: { shout: 2 } }),
    event(3, 'health-failure', { by: 'sentinel', detail: { key: finding.key, cause: 'refusal:RANK_INVERSION', since: finding.since, subject: '#1' } }),
    event(4, 'shout', { by: 'sentinel', item: null, detail: { shout: 3 } }), event(5, 'health-scan', { by: 'coordinator', item: null, detail: { active: [finding] } }),
    event(6, 'shout', { item: null, detail: { shout: 4 } }), event(7, 'activity-delivered', { item: null }), event(8, 'flake-observation', { item: null })];
  return { items, agents, shouts, events, finding };
}

test('a native sentinel scan is one collapsed disclosure, deduplicates addressed notices and retains its next step [N26]', () => {
  const data = scannedBoard(), model = activityModel(data);
  assert.deepEqual(model.counts, { all: 2, work: 0, sentinels: 1, shouts: 1 });
  const run = model.rows.find(row => row.kind === 'sentinels');
  assert.equal(run.findings.length, 1, 'two deliveries plus their health event describe one finding');
  assert.equal(run.heldBack, 8);
  const collapsed = activityHtml(model, { words: activityWords });
  assert.match(collapsed, /<details class="activity-run" data-activity-run="sentinels:5"><summary>/u);
  assert.match(collapsed, /Sentinels<\/b> checked the board/u);
  assert.match(collapsed, /view-1 holds #1 while #2 ranks above it and sits free/u);
  assert.match(collapsed, /Next: release #1, then claim #2/u);
  assert.doesNotMatch(collapsed, /\[RANK_INVERSION\]|health-scan|activity-delivered|flake-observation/u);
  assert.match(activityHtml(model, { words: activityWords, open: [run.id] }), /data-activity-run="sentinels:5" open/u);
});

test('resolved and still-stuck findings stay in their own run, with all filter counts [N26]', () => {
  const data = scannedBoard();
  data.events.push(event(9, 'health-resolved', { by: 'sentinel', detail: { key: data.finding.key, cause: 'refusal:RANK_INVERSION', since: data.finding.since, subject: '#1' } }),
    event(10, 'health-scan', { item: null, by: 'coordinator', detail: { active: [] } }), event(11, 'fact'));
  const model = activityModel(data);
  assert.deepEqual(model.counts, { all: 4, work: 1, sentinels: 2, shouts: 1 });
  const html = activityHtml(model, { words: activityWords });
  assert.match(html, /1 resolved/u);
  for (const [filter, count] of Object.entries(model.counts)) {
    const filtered = activityHtml(model, { words: activityWords, filter });
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
  const idle = activityWords({ cause: 'IDLE_AGENT', owner: 'view-1', since: at(37), why: 'view-1 has held no claim or review and pulled nothing for 30 minutes, while #2 waits in view and it could take it', next: 'take #2' }, { now });
  assert.match(idle.text, /idle for 37 minutes while #2 waits in its view lane/u);
  for (const cause of ['AFTER_WITHDRAWN', 'UNPAIRED_WORK', 'CONFLICT_HOLD_CLEARS', 'A_FUTURE_CODE']) {
    const text = activityWords({ cause, subject: '#1', next: 'inspect [A_FUTURE_CODE] at ' + at(1), since: at(2) });
    assert.doesNotMatch(JSON.stringify(text), /\[[A-Z_]+\]|2026-10-28T/u);
    assert.ok(text.text.length > 4);
  }
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

test('real board Activity has sentence rows, working filters, full quotes and an ellipsized item on desktop and phone [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Activity sentence journey.');
  const box = machine(), alpha = project(box, 'sentences');
  box.run(alpha.repo, 'add', 'web', items[0].title, '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.web, 'shout', 'coordinator', 'Keep [MY_CODE] and these words.\nSecond line at 2026-10-28T04:12:00Z', '--kind', 'idea');
  const file = join(alpha.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: native health scans must reach this real view through its HTTP board snapshot.
  const board = store.openBoard(file);
  let scanId;
  try {
    const rank = { ...scannedBoard().finding, owner: { who: 'web-1', role: 'agent' }, why: 'web-1 claimed #1 while #2 ranks ahead in the web lane and sits free' };
    const waiting = { ...rank, key: 'AFTER_WITHDRAWN:item:1', cause: 'AFTER_WITHDRAWN', why: '#1 waits on withdrawn #2', next: 'drop the withdrawn dependency' };
    const idle = { ...rank, key: 'IDLE_AGENT:agent:web-1', cause: 'IDLE_AGENT', subject: 'web-1', item: null,
      why: 'web-1 has held no claim or review and pulled nothing for 30 minutes, while #2 waits in web and it could take it' };
    for (const findings of [[rank, waiting], [waiting, idle]]) {
      const args = { agentId: 'coordinator', findings, observedRevision: store.events(board).at(-1).event_id };
      const move = prepareEngineMove(board, 'recordHealthFindings', [args], { actor: 'coordinator' });
      const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
      assert.equal(result.error, undefined, JSON.stringify(result));
    }
    scanId = store.events(board).findLast(entry => entry.event_kind === 'health-scan').event_id;
    assert.equal(store.allShouts(board).filter(entry => entry.shout_text.startsWith('Stuck:') && entry.shout_text.includes('[RANK_INVERSION]')).length, 2, 'native recording really sends the same notice to agent and coordinator');
  } finally { store.closeBoard(board); }
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-activity-sentences-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo));
    await press(chrome, 'document.querySelector("#tabs [data-tab=activity]")');
    await chrome.waitFor('!!document.querySelector("#activity [data-activity-kind=claim]")');
    assert.match(await chrome.stable('document.querySelector("#activity [data-activity-kind=claim]").textContent'), /started building/u);
    assert.doesNotMatch(await chrome.stable('document.querySelector("#activity").textContent'), /\(unknown\)|2026-10-28T/u);
    assert.equal(await chrome.stable('document.querySelector("#activity .activity-who[title]").title'), 'Test Model');
    const run = 'document.querySelector(\'[data-activity-run="sentinels:' + scanId + '"]\')';
    assert.equal(await chrome.stable(run + '.open'), false, 'the native scan starts folded');
    await press(chrome, run + '.querySelector("summary")');
    await chrome.waitFor(run + '.open');
    const lines = await chrome.stable(run + '.querySelector(".activity-lines").textContent');
    assert.match(lines, /withdrawn #2/u);
    assert.match(lines, /idle for \d+ minutes/u);
    assert.match(lines, /holds #1 while #2 ranks above it and sits free/u);
    assert.doesNotMatch(lines, /\[[A-Z_]+\]|\d{4}-\d\d-\d\dT/u);
    for (const filter of ['work', 'sentinels', 'shouts', 'all']) {
      await press(chrome, 'document.querySelector("#activity-filters [data-activity-filter=' + filter + ']")');
      await chrome.waitFor('document.querySelector("#activity-filters [data-activity-filter=' + filter + ']").getAttribute("aria-pressed") === "true"');
      const count = await chrome.stable('Number(document.querySelector("#activity-filters [data-activity-filter=' + filter + '] b").textContent)');
      assert.equal(await chrome.stable('document.querySelectorAll("#activity .activity-event").length'), count);
    }
    await press(chrome, run + '.querySelector("summary")');
    await chrome.waitFor(run + '.open');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor('innerWidth === ' + width);
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'), true);
      assert.equal(await chrome.stable('getComputedStyle(document.querySelector("#activity .activity-item")).textOverflow'), 'ellipsis');
      const quote = await chrome.stable('document.querySelector("#activity .activity-quote").textContent');
      assert.match(quote, /Keep \[MY_CODE\] and these words\.\nSecond line at \d{1,2}:\d\d [AP]M/u);
      await proofShot(chrome, 'activity-sentences', width);
    }
    await press(chrome, `document.querySelector('#activity [data-activity-kind=claim] [data-go="item:1"]')`);
    await chrome.waitFor('view.tab === "items" && String(view.item) === "1"');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
