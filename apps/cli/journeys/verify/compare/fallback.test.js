/** An unrunnable base falls back to composed head versus main [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER } from '../../../tests/fixtures/verify/compare.js';
import { fixture } from '../../../tests/fixtures/verify/compare.js';
import { submit } from '../../../tests/fixtures/verify/compare.js';
import { compare } from '../../../tests/fixtures/verify/compare.js';

test('verify --compare falls back from an unrunnable base to composed head versus main [V4,C7]', async t => {
  const box = await fixture(t, { missingRunner: true });
  writeFileSync(join(box.repo, 'web/runner.js'), RUNNER);
  box.git(box.repo, 'add', 'web/runner.js');
  box.git(box.repo, 'commit', '-qm', 'fix: provide current runner [G1]');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  writeFileSync(join(box.web, 'web/runner.js'), RUNNER);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:false,fixed:true,known:false,skip:false};\n');
  const head = submit(box);
  const result = await compare(box);
  assert.equal(result.fallback.base, box.base);
  assert.equal(result.baseCommit, main);
  assert.notEqual(result.headCommit, head);
  assert.deepEqual(result.newRed.map(row => row.name), ['new red case [V4,C7]']);
  assert.deepEqual(result.fixed.map(row => row.name), ['fixed case [V4,C7]']);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), head);
});
