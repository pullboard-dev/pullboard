/** The project config declares generated files with their generator and inputs, and refuses a declaration missing its generator [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../src/io/main.js';
import { defaults } from '../src/io/main.js';
import { describeSetting } from '../src/io/settings/descriptions.js';

test('clause 1: a project config declaring a generated file with its generator command and inputs loads, and one declaring none is unchanged [C7]', () => {
  const generated = [{ file: 'docs/api.md', generator: 'node tools/make-api.js', inputs: ['src/api.js', 'tools/make-api.js'] }];
  const config = configFromSource(JSON.stringify({ generated }));
  assert.deepEqual(config.generated, generated);
  assert.equal(defaults().generated, undefined, 'off by default');
  assert.equal(configFromSource('{}').generated, undefined);
});

test('clause 2: a generated declaration missing its generator is refused with the field named [C7]', () => {
  const missing = JSON.stringify({ generated: [{ file: 'docs/api.md', inputs: ['src/api.js'] }] });
  assert.throws(() => configFromSource(missing), error => error.name === 'Refused' && error.code === 'BAD_CONFIG'
    && /docs\/api\.md/u.test(error.message) && /"generator"/u.test(error.message));
  const blank = JSON.stringify({ generated: [{ file: 'a.txt', generator: '  ', inputs: [] }] });
  assert.throws(() => configFromSource(blank), /"generator"/u);
});

test('clause 3: the pace setting is listed in the settings descriptions as a choice [O6]', () => {
  const pace = describeSetting('pace');
  assert.equal(pace?.unit, 'choice');
  assert.match(pace.description, /steady/u);
  assert.equal(defaults().pace, 'steady');
});
