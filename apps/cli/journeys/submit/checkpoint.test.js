/** @pullboard-test-input source-tree */
/** A submit records a five-part checkpoint fact when seat.checkpoints is on, and writes nothing more when it is off [C7,#8549]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKPOINT_PARTS } from '../../../../packages/seats/index.js';
import { readCheckpoint } from '../../../../packages/seats/index.js';
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

/** Submit one small item through the real gate on a project whose seat.checkpoints is set as given, and return its fact texts. */
async function submittedFacts(t, setting) {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'], ...(setting === undefined ? {} : { seat: { checkpoints: setting } }) }));
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
  return JSON.parse(shown.out).thread.filter(row => row.type === 'fact').map(row => row.text);
}

test('clause 2: a submit records one checkpoint fact with the five parts when seat.checkpoints is on [C7,#8549]', async t => {
  const found = (await submittedFacts(t, true)).map(readCheckpoint).filter(Boolean).filter(row => row.moment === 'submit');
  assert.equal(found.length, 1, 'exactly one submit checkpoint');
  assert.deepEqual(Object.keys(found[0].fact), CHECKPOINT_PARTS);
  assert.match(found[0].fact.done[0], /^submitted [0-9a-f]{40}$/u, 'what is done names the submitted commit');
  assert.match(found[0].fact.evidence[0], /^gate job /u, 'evidence names the gate job');
});

test('clause 2: a submit adds no checkpoint fact and no other fact when seat.checkpoints is off or never set [C7,#8549]', async t => {
  const withSetting = await submittedFacts(t, true);
  for (const setting of [false, undefined]) {
    const without = await submittedFacts(t, setting);
    assert.equal(without.filter(text => readCheckpoint(text)).length, 0, `no checkpoint fact with the setting ${setting}`);
    assert.equal(without.length, withSetting.length - 2, 'a claim and a submit checkpoint are the only facts the setting adds');
  }
});
