/** pullboard trace rebuilds an agent's or an item's timeline from trace lines and board events [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import {
  sinceCutoff,
  traceLine,
  traceTimeline,
} from '../../src/io/trace.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A scratch repo with one open item on the web lane; returns the box and the item id. */
async function scratch() {
  const box = e2e.project('true');
  const id = (await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Trace me', criterion: 'The file is committed.', run: box.runLocal })).item_id;
  return { box, id };
}

test('clause 1: trace <agent> prints that agent\'s calls and board events in time order, one line each [C7]', async () => {
  const { box, id } = await scratch();
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  const json = JSON.parse((await box.runLocal(box.web, 'trace', 'web-1', '--since', '2h', '--json')).out);
  assert.equal(json.version, 1);
  const claim = json.entries.find(entry => entry.source === 'event' && entry.command === 'claim');
  assert.ok(claim, JSON.stringify(json.entries));
  assert.equal(claim.agent, 'web-1');
  assert.equal(claim.item, id);
  const times = json.entries.map(entry => Date.parse(entry.time));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'entries are in time order');
  const text = (await box.runLocal(box.web, 'trace', 'web-1')).out.trim().split('\n');
  assert.ok(text.length >= json.entries.length, 'one line per entry');
  assert.ok(text.some(line => line.split('  ')[1] === 'claim' && line.includes(`#${id}`)), text.join('\n'));
  assert.equal((await box.runLocal(box.web, 'trace', 'web-1', '--since', 'soon')).code === 0, false, 'a bad --since is refused');
});

test('clause 1: a refused call shows its refusal code and why, and --since drops older entries [C7]', () => {
  const lines = [
    { at: '2026-11-06T10:00:00.000Z', agent: 'web-1', command: 'claim', item: 7, exit: 1, refusal: { code: 'ITEM_TAKEN', message: 'held by api-1' }, ms: 12 },
    { at: '2026-11-06T12:00:00.000Z', agent: 'web-1', command: 'show', item: 7, exit: 0, refusal: null, ms: 5 },
    { at: '2026-11-06T12:30:00.000Z', agent: 'api-1', command: 'show', item: 8, exit: 0, refusal: null, ms: 5 },
  ];
  const all = traceTimeline({ lines, events: [], subject: 'web-1' });
  assert.deepEqual(all.map(entry => entry.outcome), ['ITEM_TAKEN', 'ok']);
  assert.equal(traceLine(all[0]), '2026-11-06T10:00:00.000Z  claim  #7  ITEM_TAKEN  12ms  held by api-1');
  const recent = traceTimeline({ lines, events: [], subject: 'web-1', since: sinceCutoff('2h', Date.parse('2026-11-06T13:00:00.000Z')) });
  assert.deepEqual(recent.map(entry => entry.command), ['show']);
});

test('clause 1: a successful call shows the intent the agent stated with --why [C7]', () => {
  const lines = [
    { at: '2026-11-06T12:00:00.000Z', agent: 'web-1', command: 'show', item: 7, exit: 0, refusal: null, ms: 5, why: 'checking the bar before building' },
    { at: '2026-11-06T12:01:00.000Z', agent: 'web-1', command: 'show', item: 7, exit: 0, refusal: null, ms: 4, why: null },
  ];
  const entries = traceTimeline({ lines, events: [], subject: 'web-1' });
  assert.equal(traceLine(entries[0]), '2026-11-06T12:00:00.000Z  show  #7  ok  5ms  checking the bar before building');
  assert.equal(traceLine(entries[1]), '2026-11-06T12:01:00.000Z  show  #7  ok  4ms  -');
});

test('clause 2: trace <item> prints every agent\'s calls and events on that item, and --json is one versioned document [C7]', async () => {
  const { box, id } = await scratch();
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  assert.equal((await box.runLocal(box.web, 'show', String(id), '--json')).code, 0);
  const run = (await box.runLocal(box.web, 'trace', String(id), '--json'));
  assert.equal(run.code, 0, run.err);
  const json = JSON.parse(run.out);
  assert.equal(json.version, 1);
  assert.equal(json.subject, String(id));
  assert.ok(json.entries.every(entry => entry.item === id), 'only entries on the item');
  assert.ok(json.entries.some(entry => entry.source === 'call' && entry.command === 'show'), 'the show call is traced');
  assert.ok(json.entries.some(entry => entry.source === 'event' && entry.command === 'claim'), 'the claim event is listed');
  const mixed = traceTimeline({
    lines: [{ at: '2026-11-06T10:00:00.000Z', agent: 'api-1', command: 'show', item: 9, exit: 0, ms: 3 }, { at: '2026-11-06T10:00:01.000Z', agent: 'web-1', command: 'show', item: 8, exit: 0, ms: 3 }],
    events: [{ event_at: '2026-11-06T10:00:02.000Z', event_by: 'web-1', event_kind: 'release', item_id: 9, event_detail: '{"reason":"BLOCKED","note":"waits"}' }],
    subject: '#9',
  });
  assert.deepEqual(mixed.map(entry => [entry.agent, entry.command, entry.why]), [['api-1', 'show', ''], ['web-1', 'release', 'BLOCKED']]);
});
