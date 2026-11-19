/** @pullboard-test-input source-tree */
/** A submit records a five-part checkpoint fact when seat.checkpoints is on, and writes nothing when it is off [C7,#8549]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { CHECKPOINT_PARTS } from '../../../../packages/seats/index.js';
import { readCheckpoint } from '../../../../packages/seats/index.js';
import { recordCheckpoint } from '../../src/io/seat-checkpoint.js';
import {
  builderRepo,
  commitAll,
  privateRepo,
  put,
} from '../../tests/fixtures/submit/gate.js';
import {
  coordinatorLocal,
  runLocal,
  submitSettled,
} from './gate/local.js';

test('cli.journeys-submit-checkpoint.a-submit-records-one-checkpoint-fact: clause 2: a submit records one checkpoint fact with the five parts when seat.checkpoints is on [C7,#8549]', async t => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'], seat: { checkpoints: true } }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  commitAll(box);
  box = builderRepo(box);
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'Checkpointed submit')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): change the value [G1]');
  const result = await submitSettled(t, box, (...args) => runLocal(box, ...args));
  assert.equal(result.code, 0, result.err);
  const shown = await runLocal(box, 'show', '1', '--json');
  assert.equal(shown.code, 0, shown.err + shown.out);
  const found = JSON.parse(shown.out).thread.filter(row => row.type === 'fact').map(row => readCheckpoint(row.text)).filter(Boolean);
  assert.deepEqual(found.map(row => row.moment), ['claim', 'submit'], 'the claim and the submit each record one');
  assert.deepEqual(Object.keys(found[1].fact), CHECKPOINT_PARTS);
  assert.match(found[1].fact.done[0], /^submitted [0-9a-f]{40}$/u, 'what is done names the submitted commit');
  assert.match(found[1].fact.evidence[0], /^gate job /u, 'evidence names the gate job');
});

test('cli.journeys-submit-checkpoint.with-seat-checkpoints-off-or-never: clause 2: with seat.checkpoints off or never set, the checkpoint writes nothing: no ordered move, no fact [C7,#8549]', async () => {
  for (const source of ['{}', '{"seat":{"checkpoints":false}}']) {
    const moves = [];
    const ctx = { config: configFromSource(source), io: { err: line => moves.push(line) } };
    const recorded = await recordCheckpoint(ctx, {}, { item: 1, agent: 'core-1', moment: 'submit', parts: { done: ['x'] } }, (...move) => moves.push(move));
    assert.equal(recorded, false, `nothing recorded for ${source}`);
    assert.deepEqual(moves, [], `no board write and no output for ${source}`);
  }
});
