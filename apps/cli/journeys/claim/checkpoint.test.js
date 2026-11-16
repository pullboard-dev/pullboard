/** @pullboard-test-input source-tree */
/** A claim records a five-part checkpoint fact when seat.checkpoints is on, and writes nothing more when it is off [C7,#8549]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKPOINT_PARTS } from '../../../../packages/seats/index.js';
import { readCheckpoint } from '../../../../packages/seats/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  builderRepo,
  commitAll,
  privateRepo,
  put,
  withBrief,
} from '../../tests/fixtures/submit/gate.js';

/** A builder box on a project whose seat.checkpoints is set as given, with one open item #1. */
async function boardWith(t, setting) {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'], ...(setting === undefined ? {} : { seat: { checkpoints: setting } }) }));
  commitAll(box);
  box = builderRepo(box);
  const as = (root, ...args) => runCliInProcess(withBrief(...args), { cwd: root, env: box.env });
  const added = await as(join(box.dir, 'repo'), 'add', 'build', 'Checkpointed claim', '--check', 'true');
  assert.equal(added.status, 0, added.stderr + added.stdout);
  return { box, as };
}

/** The item's fact texts, read through the real `show` command. */
async function facts({ box, as }) {
  const shown = await as(box.root, 'show', '1', '--json');
  assert.equal(shown.status, 0, shown.stderr + shown.stdout);
  return JSON.parse(shown.stdout).thread.filter(row => row.type === 'fact').map(row => row.text);
}

test('clause 1: a claim records one checkpoint fact with the five parts when seat.checkpoints is on [C7,#8549]', async t => {
  const board = await boardWith(t, true);
  const claimed = await board.as(board.box.root, 'claim', '1');
  assert.equal(claimed.status, 0, claimed.stderr + claimed.stdout);
  const found = (await facts(board)).map(readCheckpoint).filter(Boolean);
  assert.equal(found.length, 1, 'exactly one checkpoint fact');
  assert.equal(found[0].moment, 'claim');
  assert.deepEqual(Object.keys(found[0].fact), CHECKPOINT_PARTS);
  assert.match(found[0].fact.left[0], /^build #1: Checkpointed claim$/u, 'what is left names the item');
});
