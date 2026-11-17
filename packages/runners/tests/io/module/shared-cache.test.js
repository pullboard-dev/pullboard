/** @pullboard-test-loads packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/src/io/keyed.js */
/** Runner jobs on one runner share keyed cache entries, so a later job's cold trip reuses what an earlier job derived [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { compiledIn } from '../../fixtures/parse-store.js';
import { boundKeyedFolder } from '../../../src/io/keyed.js';
import { sharedCacheFolder } from '../../../src/io/keyed.js';

test('runners.shared-cache.n8233-clause-1-two-runner-jobs: 8233 clause 1: two runner jobs on one runner reuse one keyed cache entry for an unchanged tree [C7]', t => {
  const runner = privateFixtureFiles('pullboard-shared-cache-').root;
  t.after(() => rmSync(runner, { recursive: true, force: true }));
  const shared = join(runner, 'shared-cache');
  mkdirSync(shared, { mode: 0o700 });
  const [first, second, alone] = ['job-1', 'job-2', 'job-3'].map(name => { const tmp = join(runner, 'jobs', name, 'tmp'); mkdirSync(tmp, { recursive: true }); return tmp; });
  const source = `import { a } from './shared-probe-${process.pid}-${Date.now()}.js';\nexport const b = a;\n`;

  const cold = compiledIn(first, source, shared);
  assert.equal(cold.count, 1, 'the first job on the runner compiles the source');
  const entries = readdirSync(join(shared, 'runner-parse-cache')).filter(name => name.endsWith('.result'));
  assert.equal(entries.length, 1, 'its result is kept once, under the runner, keyed by content');
  assert.ok(!existsSync(join(first, 'pullboard-runner-parse-cache')), 'nothing is kept in the job\'s own temporary folder');

  assert.deepEqual(compiledIn(second, source, shared), { ...cold, count: 0 }, 'a second job with its own TMPDIR reads the same entry and compiles nothing');
  assert.deepEqual(readdirSync(join(shared, 'runner-parse-cache')).filter(name => name.endsWith('.result')), entries, 'both jobs used the one entry');
  assert.equal(compiledIn(alone, source).count, 1, 'a process outside a runner job keeps its own private store');
});

test('runners.shared-cache.n8233-a-shared-cache-folder-others: 8233: a shared cache folder others could write is never used, and a folder is bounded by size, oldest first [C7]', t => {
  const runner = privateFixtureFiles('pullboard-shared-bound-').root;
  t.after(() => rmSync(runner, { recursive: true, force: true }));
  const shared = join(runner, 'shared-cache');
  mkdirSync(shared, { mode: 0o700 });
  const env = { PULLBOARD_RUNNER_SHARED_CACHE: shared };
  assert.equal(sharedCacheFolder('probe', { PULLBOARD_RUNNER_SHARED_CACHE: 'relative/cache' }), null, 'a relative name is no shared cache');
  assert.equal(sharedCacheFolder('probe', {}), null, 'outside a runner job there is none');
  const folder = sharedCacheFolder('probe', env);
  assert.equal(folder, join(shared, 'probe'));
  chmodSync(folder, 0o770);
  assert.equal(sharedCacheFolder('probe', env), null, 'a folder its group could write is never read');
  chmodSync(folder, 0o700);

  const now = Date.now() / 1000;
  for (const [index, name] of ['old', 'middle', 'new'].entries()) {
    writeFileSync(join(folder, `${name}.result`), 'x'.repeat(100));
    utimesSync(join(folder, `${name}.result`), now - 300 + index * 100, now - 300 + index * 100);
  }
  assert.equal(boundKeyedFolder(folder, 250), 1, 'only enough of the oldest go to fit the bound');
  assert.deepEqual(readdirSync(folder).sort(), ['middle.result', 'new.result']);
  assert.equal(boundKeyedFolder(folder, 250), 0, 'a folder within its bound keeps everything');
});
