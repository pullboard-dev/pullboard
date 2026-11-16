/** An exit-rule stop records a five-part checkpoint fact from the native counters when seat.checkpoints is on, and nothing more when it is off [C7,#8553]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCheckpoint } from '../../../../packages/seats/index.js';
import {
  SUMMARY,
  exitStopBoard,
} from '../../tests/fixtures/next/exit-stop.js';

const ON = '{"exitRules":{"enabled":true,"tokens":100,"calls":3},"seat":{"checkpoints":true}}';

test('clause 1: the exit-rule stop records one checkpoint fact with the five parts and the native counters when seat.checkpoints is on [C7,#8553]', t => {
  const stop = exitStopBoard(t, ON);
  stop.count({ tokens: 120, calls: 2 });
  stop.stop();
  const found = stop.facts().map(readCheckpoint).filter(Boolean);
  assert.equal(found.length, 1, 'exactly one checkpoint fact');
  assert.equal(found[0].moment, 'exit-stop');
  assert.deepEqual(found[0].fact, {
    done: ['wired the stop'],
    left: ['write the journey'],
    decisions: ['Failed: none'],
    evidence: ['EXIT_BUDGET: 120 tokens, 2 calls'],
    tokens: 120,
  });
  assert.ok(stop.facts().includes(SUMMARY), 'the existing summary note is still recorded');
});

test('clause 1: the exit-rule stop adds no checkpoint fact and no other fact when seat.checkpoints is off or never set [C7,#8553]', t => {
  const on = exitStopBoard(t, ON);
  on.count({ tokens: 120, calls: 2 });
  on.stop();
  for (const source of ['{"seat":{"checkpoints":false}}', '{}']) {
    const off = exitStopBoard(t, source);
    off.count({ tokens: 120, calls: 2 });
    off.stop();
    assert.equal(off.facts().filter(readCheckpoint).length, 0, `no checkpoint fact for ${source}`);
    assert.equal(off.facts().length, on.facts().length - 1, 'the checkpoint is the only fact the setting adds');
  }
});
