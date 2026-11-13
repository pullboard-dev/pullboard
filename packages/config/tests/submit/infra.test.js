/** @pullboard-test-input packages/config/src/io/main.js */
/**
 * The submit infra-note policy rejects invalid known values and warns on unknown keys [C7,V4,N26].
 */
import assert from 'node:assert/strict';
import { runFixtureChild } from '../../../../apps/cli/tests/fixtures/child.js';
import { test } from 'node:test';
import { configFromSource } from '../../index.js';

test('infra-note policies reject invalid known values and warn on unknown keys [C7,V4,N26]', () => {
  assert.equal(configFromSource('{}').submit.requireInfraNote, false);
  assert.equal(configFromSource('{"submit":{}}').submit.requireInfraNote, false);
  assert.equal(configFromSource('{"submit":{"requireInfraNote":true}}').submit.requireInfraNote, true);
  for (const submit of [null, [], true, { requireInfraNote: 'true' }, { requireInfraNote: 1 }, { requireInfraNote: null }]) {
    assert.throws(() => configFromSource(JSON.stringify({ submit })), error => error.code === 'BAD_CONFIG');
  }
  // A fresh real process proves the forward-compatible warning, including its exact nested path.
  const source = `import {configFromSource} from ${JSON.stringify(new URL('../../src/io/main.js', import.meta.url).href)};
console.log(JSON.stringify(configFromSource('{"submit":{"requireInfraNotes":true}}').submit));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.failure || result.stderr);
  const submit = JSON.parse(result.stdout);
  assert.equal(submit.requireInfraNote, false, 'the typo cannot enable the actual policy');
  assert.equal(Object.hasOwn(submit, 'requireInfraNotes'), false, 'unknown settings are ignored');
  assert.match(result.stderr, /ignoring unknown setting key "requireInfraNotes" at "submit"\."requireInfraNotes"/u);
});
