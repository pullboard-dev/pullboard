/** @pullboard-test-loads packages/codemap/src/io/parsed.js */
/** The parse store answers many sources in batched lookups and compiles only the misses [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { storedCompilations } from '../../src/io/parsed.js';

test('codemap.parsed-batch.c-1-200-sources-look-up: 8242 clause 1: 1,200 sources look up in batches and only the unseen source compiles [C7]', t => {
  const shared = privateFixtureFiles('pullboard-parsed-batch-').root;
  const before = process.env.PULLBOARD_RUNNER_SHARED_CACHE;
  process.env.PULLBOARD_RUNNER_SHARED_CACHE = shared;
  t.after(() => { if (before === undefined) delete process.env.PULLBOARD_RUNNER_SHARED_CACHE; else process.env.PULLBOARD_RUNNER_SHARED_CACHE = before; rmSync(shared, { recursive: true, force: true }); });
  const sources = Array.from({ length: 1200 }, (_, index) => `import './m${index}.js';`);
  const asked = [];
  const compile = missing => { asked.push(missing.length); return missing.map(source => ({ compiles: true, imports: [source] })); };
  const first = storedCompilations('epoch', sources, compile);
  const second = storedCompilations('epoch', [...sources, 'import "./new.js";'], compile);
  assert.deepEqual(asked, [1200, 1], 'the second call compiles only the one source the store lacks');
  assert.deepEqual(second.slice(0, 1200), first, 'stored rows equal the compiled ones, in order');
});
