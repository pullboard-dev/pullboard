/** A fresh seat reads its first inbox on a 100k-event board fast [C7]. */
import assert from 'node:assert/strict';

import {
  readFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import { test } from 'node:test';

import { largeBoard } from '../../tests/fixtures/board/large.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

import { PULLBOARD_ENTRY } from '../../src/io/resident/client.js';
import { residentPoolSize } from '../../src/io/resident/client.js';
import { residentSocket } from '../../src/io/resident/client.js';
import { performance } from 'node:perf_hooks';

test('[C7] a fresh seat first inbox on a board of 100k events answers under 300 ms and later reads are unchanged', (t) => {
  const box = largeBoard(t);
  box.beforeCleanup(() => {
    for (let slot = 0; slot < residentPoolSize({}); slot += 1) {
      const place = residentSocket(box.repo, PULLBOARD_ENTRY, slot);
      if (!place) continue;
      try { process.kill(Number(readFileSync(place.pid, 'utf8').trim()), 'SIGKILL'); } catch { /* None started, or it already exited. */ }
    }
  });
  // The resident board process serves the board commands, as on a person's machine; test markers would turn it off.
  for (const name of ['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) delete box.env[name];
  box.env.PULLBOARD_RESIDENT = '1';
  // The seat joins after the board is seeded, as a new worker does; it has not yet read its inbox.
  const seat = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
  const joined = joinFixtureSeat(box, seat, 'web');
  assert.equal(joined.code, 0, `${joined.err}${joined.out}`);
  // Two untimed commands start and warm the resident process.
  const timed = (command = 'inbox') => {
    const started = performance.now();
    const result = box.run(seat, command, '--json');
    return { ms: performance.now() - started, result };
  };
  for (let run = 0; run < 2; run += 1) assert.equal(timed('status').result.code, 0);
  const first = timed();
  assert.equal(first.result.code, 0, first.result.err + first.result.out);
  assert.ok(first.ms < 300, `the first inbox took ${first.ms.toFixed(0)} ms, over its 300 ms budget`);
  const document = JSON.parse(first.result.out);
  assert.deepEqual(document.activity.interrupts, [], 'nothing from before the seat joined is owed to it');
  const second = timed();
  assert.equal(second.result.code, 0, second.result.err + second.result.out);
  assert.match(second.result.out, /no new shouts or activity|"shouts": \[\]/u);
});
