/** pullboard heartbeat --claims keeps every claim and queued gate of a seat alive through heartbeatSeat, then exits [B3,C7,#3784]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { keepClaimsAlive } from '../../../../packages/gate/index.js';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: the seat is beaten with its board file while it holds a claim, every 30 s, and the loop exits once it holds none [B3,C7]', async () => {
  const beats = [], waits = [];
  let held = 2;
  const result = await keepClaimsAlive('/any/checkout', {
    seatOf: () => ({ seat: 'core-7', item: 12, file: '/repo/.git/pullboard/seat-timing.jsonl' }),
    held: async (file, seat) => { assert.deepEqual([file, seat], ['/repo/.git/pullboard/board.sqlite', 'core-7']); return held-- > 0; },
    beat: async (file, seat) => { beats.push([file, seat]); },
    wait: async ms => { waits.push(ms); },
  });
  assert.deepEqual(result, { seat: 'core-7', beats: 2 });
  assert.deepEqual(beats, [['/repo/.git/pullboard/board.sqlite', 'core-7'], ['/repo/.git/pullboard/board.sqlite', 'core-7']]);
  assert.deepEqual(waits, [30_000, 30_000], 'one beat every 30 s, well inside the two-minute seat-gone limit');
});

test('clause 1: a directory with no seat beats nothing and returns at once [B3,C7]', async () => {
  const result = await keepClaimsAlive('/no/seat', { seatOf: () => null,
    held: async () => { throw new Error('no read'); }, beat: async () => { throw new Error('no beat'); } });
  assert.deepEqual(result, { seat: null, beats: 0 });
});

test('clause 1: from a joined seat checkout the loop beats its real board while the claim lives and ends when the claim is released [B3,C7]', async () => {
  const box = helpers.project('true');
  const joined = joinFixtureSeat(box, box.web, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  const seat = JSON.parse(joined.out).agent;
  const id = String(fileFixtureItem(box, box.repo, { lane: 'web', title: 'Kept alive', check: 'true', args: ['--specs', 'G1'] }).item_id);
  const claimed = (await box.runLocal(box.web, 'claim', id));
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const beats = [];
  const result = await keepClaimsAlive(box.web, {
    beat: async (file, beaten) => { beats.push([file, beaten]); },
    // After the first beat the builder releases, so the next held check reads no claim and the loop ends.
    wait: async () => {
      const released = (await box.runLocal(box.web, 'release', id, '--reason', 'BLOCKED', '--note', 'fixture keepalive done'));
      assert.equal(released.code, 0, `${released.out}\n${released.err}`);
    },
  });
  assert.deepEqual(result, { seat, beats: 1 });
  assert.deepEqual(beats.map(([file, beaten]) => [realpathSync(file), beaten]), [[realpathSync(join(box.repo, '.git', 'pullboard', 'board.sqlite')), seat]],
    'the seat is beaten against its own board file');
});
