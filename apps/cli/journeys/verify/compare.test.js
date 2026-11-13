/** Real persisted items compare actual Node tests at immutable Git sources [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../tests/fixtures/verify/compare.js';
import { submit } from '../../tests/fixtures/verify/compare.js';
import { compare } from '../../tests/fixtures/verify/compare.js';

test('verify --compare selects importing tests and reports only new reds and actual fixes [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:true};\n');
  const head = submit(box);
  const result = await compare(box);
  assert.equal(result.headCommit, head);
  assert.equal(result.baseCommit, box.base);
  assert.deepEqual(result.files, ['web/a space.test.js']);
  assert.deepEqual(result.newRed.map(row => row.name), ['new red case [V4,C7]']);
  assert.deepEqual(result.fixed.map(row => row.name), ['fixed case [V4,C7]']);
  assert.equal(result.fallback, null);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});

test('verify --compare treats an added test file as new and does not execute its missing base path [V4,C7]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/added.test.js'), "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from './value.js';test('added red [V4,C7]',()=>assert.equal(value.newRed,false));\n");
  submit(box);
  const result = await compare(box);
  assert.deepEqual(result.newFiles, ['web/added.test.js']);
  assert.deepEqual(result.base.files, []);
  assert.deepEqual(result.newRed.map(row => row.name), ['added red [V4,C7]']);
  assert.equal(result.fallback, null);
});
