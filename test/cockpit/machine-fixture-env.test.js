/** A scratch machine starts from an environment with no PULLBOARD_ variables of the running seat [C7,O5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machine, project } from './machine-fixture.js';

test('machine() drops the parent seat PULLBOARD_ identity and joins on the requested route [C7,O5]', () => {
  const saved = { ...process.env };
  process.env.PULLBOARD_MODEL = 'gpt-6-luna';
  process.env.PULLBOARD_AGENT = 'x';
  process.env.PULLBOARD_SEAT_LEAK = 'leak';
  try {
    const box = machine();
    assert.equal(Object.hasOwn(box.env, 'PULLBOARD_MODEL'), false);
    assert.equal(Object.hasOwn(box.env, 'PULLBOARD_AGENT'), false);
    assert.equal(Object.hasOwn(box.env, 'PULLBOARD_SEAT_LEAK'), false);
    assert.equal(box.env.PULLBOARD_HOME.startsWith(box.dir), true);
    project(box, 'envdemo');
    const join = box.invocations.find(call => call.args[0] === 'join');
    assert.ok(join, 'the fixture joined a seat');
    assert.equal(join.args[join.args.indexOf('--route') + 1], 'strong');
    assert.ok(join.args.includes('--model'), 'the join names its own model');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
