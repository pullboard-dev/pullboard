/** An empty runner pool records an unavailable comparison [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { HOST } from '../../../tests/fixtures/runner/ssh.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
import { fixture } from '../../../tests/fixtures/verify/compare.js';
import { submit } from '../../../tests/fixtures/verify/compare.js';

test('an empty configured runner pool records an unavailable comparison without dispatch [C7,V4]', async t => {
  const box = await fixture(t);
  writeFileSync(join(box.web, 'web/value.js'), 'export const value={newRed:true,fixed:true,known:true,skip:true};\n');
  const head = submit(box);
  const removed = await box.runLocal(box.repo, 'runner', 'remove', HOST, '--json');
  assert.equal(removed.code, 0, removed.out + removed.err);
  const requests = join(box.dir, 'requests');
  const before = existsSync(requests) ? readFileSync(requests, 'utf8') : '';
  const result = await runFixtureChildAsync(process.execPath,
    [box.helpers.BIN, 'verify', String(box.id), '--compare', '--json'], { cwd: box.web, env: box.env });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const comparison = JSON.parse(result.stdout);
  assert.equal(comparison.status, 'unavailable');
  assert.equal(comparison.source, head);
  assert.match(comparison.error, /no configured runner/u);
  const shown = await box.runLocal(box.repo, 'show', String(box.id), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.equal(JSON.parse(shown.out).comparison.status, 'unavailable', 'the ordinary diagnostic records its unavailable fact');
  assert.equal(existsSync(requests) ? readFileSync(requests, 'utf8') : '', before, 'no worker dispatch was attempted');
});
