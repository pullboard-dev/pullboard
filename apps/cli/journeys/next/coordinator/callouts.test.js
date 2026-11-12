/** Unanswered coordinator call-outs: the open rule and the one line next prints [N2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  calloutLine,
  openCallouts,
} from '../../../../../packages/activity/index.js';
import { main } from '../../../tests/fixtures/native.js';
import { fixture } from '../../../tests/fixtures/next/take.js';

const MINUTE = 60_000;

/** Run the real next and capture everything it prints. */
async function next(box, ...flags) {
  let out = '', err = '';
  const code = await main(['next', ...flags], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

test('clause 1: a call-out stays open until it is answered or its item changes [N2,C7]', () => {
  const callouts = [{ id: 1, at: 'a', text: '#10 needs a sharper bar' }, { id: 2, at: 'a', text: '#11 needs a sharper bar' },
    { id: 3, at: 'a', text: '#12 needs a sharper bar' }, { id: 4, at: 'a', text: 'a decision with no item' }];
  const open = openCallouts(callouts, new Set([2]), item => item === 12);
  assert.deepEqual(open.map(callout => callout.id), [1, 4], 'answered #2 and changed #12 are closed');
});

test('clause 2: next prints one line after 15 minutes naming how many, the oldest age and the command [N2,C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Held item');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'fixture hold' });
  store.shout(box.board, { from: box.seats.actor.id, to: 'coordinator', text: `#${held} needs a sharper bar`, lanes: ['web'] });
  assert.doesNotMatch((await next(box)).text, /call-out/u, 'a fresh call-out is quiet');
  box.advance(20 * MINUTE);
  const result = await next(box);
  const lines = result.text.split(/\r?\n/u).filter(line => line.includes('call-out'));
  assert.equal(lines.length, 1, result.text);
  assert.match(lines[0], /1 unanswered call-out to the coordinator, oldest 20 min; the coordinator runs pullboard inbox to see it; tell /u);
  assert.match(lines[0], /tell whoever runs the coordinator$/u);
});

test('clause 3: the line disappears once the call-out is answered or its item changes [N2,C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Held item');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'fixture hold' });
  store.shout(box.board, { from: box.seats.actor.id, to: 'coordinator', text: `#${held} needs a sharper bar`, lanes: ['web'] });
  box.advance(20 * MINUTE);
  assert.match((await next(box)).text, /1 unanswered call-out/u);
  store.releaseItemHold(box.board, held, { agentId: 'coordinator' });
  assert.doesNotMatch((await next(box)).text, /call-out/u, 'lifting the hold closes it');
});

test('clause 2: a board with no coordinator seat tells the person [N2,C7]', () => {
  const line = calloutLine([{ at: '2026-11-08T09:00:00Z' }], Date.parse('2026-11-08T12:00:00Z'), false);
  assert.match(line, /3 h 0 min; .*tell the person who owns this board$/u);
});

test('calloutLine is quiet below the threshold and pluralizes [N2,C7]', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.equal(calloutLine([{ at: '2026-11-08T11:50:00Z' }], now, true), null);
  assert.match(calloutLine([{ at: '2026-11-08T09:50:00Z' }, { at: '2026-11-08T10:00:00Z' }], now, true), /^2 unanswered call-outs to the coordinator, oldest 2 h 10 min; .*them; tell whoever runs the coordinator$/u);
});

test('clause 2: a next that ends in a refusal still prints the line [N2,C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Held item');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'fixture hold' });
  store.shout(box.board, { from: box.seats.actor.id, to: 'coordinator', text: `#${held} needs a sharper bar`, lanes: ['web'] });
  box.advance(20 * MINUTE);
  const result = await next(box, '--verify');
  assert.notEqual(result.code, 0, 'a verify next with nothing to review is refused');
  assert.match(result.text, /1 unanswered call-out to the coordinator, oldest 20 min/u, result.text);
});
