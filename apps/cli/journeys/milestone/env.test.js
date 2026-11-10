/** A scratch machine starts from an environment with no PULLBOARD_ variables of the running seat [C7,O5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  machine,
  project,
} from '../../tests/fixtures/cockpit/machine.js';

const SEAT_MODEL = 'seat-model';
/** Run body with the parent process carrying a seat's identity, then restore the environment. */
function asSeat(body) {
  const saved = { ...process.env };
  process.env.PULLBOARD_MODEL = SEAT_MODEL;
  process.env.PULLBOARD_AGENT = 'x';
  process.env.PULLBOARD_SEAT_LEAK = 'leak';
  try {
    body();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('clause 1: machine() env has no PULLBOARD_ variables of the parent seat [C7,O5]', () => {
  asSeat(() => {
    const box = machine();
    assert.equal(Object.hasOwn(box.env, 'PULLBOARD_MODEL'), false);
    assert.equal(Object.hasOwn(box.env, 'PULLBOARD_AGENT'), false);
    assert.equal(Object.hasOwn(box.env, 'PULLBOARD_SEAT_LEAK'), false);
    assert.equal(box.env.PULLBOARD_HOME.startsWith(box.dir), true);
  });
});

test('clause 2: fixture joins pass an explicit --model and the requested strong route [C7,O5]', () => {
  asSeat(() => {
    const box = machine();
    project(box, 'envdemo');
    const join = box.invocations.find(call => call.args[0] === 'join');
    assert.ok(join, 'the fixture joined a seat');
    assert.equal(join.args[join.args.indexOf('--route') + 1], 'strong');
    assert.ok(join.args.includes('--model'), 'the join names its own model');
  });
});
