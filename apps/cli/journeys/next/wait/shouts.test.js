/** An idle `next --wait` hears shouts on every retry and returns on one that names an item [B3,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shout } from '../../../../../packages/store/index.js';
import { unreadCount } from '../../../../../packages/store/index.js';
import { fixture } from '../../../tests/fixtures/next/take.js';
import { main } from '../../../tests/fixtures/native.js';

test('a seat idling in next --wait sees a mid-wait shout once and returns on a shout naming an item [B3,N2]', async t => {
  const box = await fixture(t);
  const target = box.add('Review request that arrives while the seat idles', { lane: 'docs' });
  const actor = box.seats.actor;
  const plain = 'routing note: stand by for the coordinator, nothing to act on yet';
  const asking = `please review #${target} now`;
  let out = '', sentPlain = false, sentAsk = false;
  const send = text => shout(box.board, { from: 'coordinator', to: actor.id, text, lanes: ['web', 'review', 'docs'] });
  const code = await main(['next', '--wait', '1'], { cwd: actor.path, clock: box.clock,
    stdout: { isTTY: false, write: part => {
      out += part;
      if (!sentAsk && out.includes(plain)) { sentAsk = true; send(asking); }
    } },
    stderr: { write: part => {
      // The idle notice is the first sign the seat is waiting: the plain shout then arrives mid-wait.
      if (!sentPlain && part.includes('next waiting')) { sentPlain = true; send(plain); }
    } } });
  assert.equal(code, 0, out);
  assert.equal(sentPlain, true, 'the seat really idled before the shout');
  assert.equal(out.split(plain).length - 1, 1, 'the mid-wait shout printed exactly once');
  assert.ok(out.includes(`act on #${target}`), out);
  assert.equal(unreadCount(box.board, actor.id), 0, 'both shouts were marked read');
});
