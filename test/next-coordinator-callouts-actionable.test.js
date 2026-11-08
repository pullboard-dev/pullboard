/** The coordinator call-out line counts only open, actionable call-outs, not every shout ever sent [N2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { actionableCallout } from '../packages/activity/index.js';
import { main } from './native-cli-fixture.js';
import { fixture } from './next-take-fixture.js';

const MINUTE = 60_000;

/** Run the real next and capture everything it prints. */
async function next(box, ...flags) {
  let out = '', err = '';
  const code = await main(['next', ...flags], { cwd: box.seats.actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  return { code, text: `${out}${err}` };
}

/** Shout to the coordinator from the fixture's actor seat. */
function shout(box, text) {
  store.shout(box.board, { from: box.seats.actor.id, to: 'coordinator', text, lanes: ['web'] });
}

test('clause 1: only the four actionable kinds count; takeover, released-claim and Resolved shouts never do [N2,C7]', () => {
  for (const text of ['#10 needs a sharper bar', 'Queued gate for #11 stopped on infrastructure (GATE_INFRA_EXHAUSTED)',
    '#12 has two send-backs at the strongest route; core-1 built it', 'Stuck: decision #13 unanswered [DECISION_UNANSWERED], since 2026-11-08T00:00:00Z']) {
    assert.equal(actionableCallout(text), true, text);
  }
  for (const text of ['core-1 (gpt-6-luna) took over this checkout in a new agent session', 'Resolved: #10 needs a sharper bar',
    'Released your claim on #12: seat has no heartbeat', 'Health: 5 more notices from this run were held back', 'Resolved: decision #13 unanswered [DECISION_UNANSWERED]']) {
    assert.equal(actionableCallout(text), false, text);
  }
});

test('clause 1: next on a board seeded with thousands of old shouts counts only the open actionable call-out [N2,C7]', { timeout: 300_000 }, async t => { // budget: 1,500 seeded shouts through the store, then two real next runs; hang ceiling, not speed.
  const box = await fixture(t);
  const held = box.add('Held item');
  const done = box.add('Moved on');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'fixture hold' });
  store.holdItem(box.board, done, { agentId: 'coordinator', reason: 'fixture hold' });
  for (let index = 0; index < 700; index++) shout(box, `core-${index} (gpt-6-luna) took over this checkout in a new agent session`);
  for (let index = 0; index < 700; index++) shout(box, `Resolved: #${held} a free item ranks ahead [RANK_INVERSION], since 2026-10-01T00:00:00Z`);
  for (let index = 0; index < 100; index++) shout(box, `Released your claim on #${held}: seat has no heartbeat for two minutes`);
  shout(box, `#${held} needs a sharper bar`);
  shout(box, `#${done} needs a sharper bar`);
  store.releaseItemHold(box.board, done, { agentId: 'coordinator' });
  box.advance(20 * MINUTE);
  const result = await next(box);
  const lines = result.text.split(/\r?\n/u).filter(line => line.includes('call-out'));
  assert.equal(lines.length, 1, result.text);
  assert.match(lines[0], /^1 unanswered call-out to the coordinator, oldest 20 min;/u, 'one open actionable call-out among 1,500 old shouts');
});

test('clause 1: a call-out about an item that is no longer held, open or claimed stops counting [N2,C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Held item');
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'fixture hold' });
  shout(box, `#${held} needs a sharper bar`);
  box.advance(20 * MINUTE);
  assert.match((await next(box)).text, /1 unanswered call-out/u);
  store.withdraw(box.board, held, { agentId: 'coordinator', reason: 'fixture withdraw' });
  assert.doesNotMatch((await next(box)).text, /call-out/u, 'a withdrawn subject closes the call-out');
});
