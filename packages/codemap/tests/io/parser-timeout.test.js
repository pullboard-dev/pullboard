/** @pullboard-test-loads packages/codemap/src/io/module/imports.js */
/** The V8 import parser survives runner load by splitting a timed-out batch, never by waiting longer [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { compileSources } from '../../src/io/module/imports.js';

/** A scripted parser child: any batch of more than one source is killed at the timeout; one source answers with its own text. */
function scriptedChild(calls) {
  return (_node, args, options) => {
    const sources = JSON.parse(readFileSync(args.at(-1), 'utf8'));
    calls.push({ count: sources.length, timeout: options.timeout });
    if (sources.length > 1) return { status: null, signal: 'SIGKILL', error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
    return { status: 0, stdout: JSON.stringify(sources.map(source => ({ compiles: true, imports: [source] }))), stderr: '' };
  };
}

/** Run with the shared parse store and NODE_OPTIONS isolated, so a cached or foreign-preload run cannot change the count. */
function isolated(t) {
  const shared = privateFixtureFiles('pullboard-parser-timeout-').root;
  const saved = { shared: process.env.PULLBOARD_RUNNER_SHARED_CACHE, options: process.env.NODE_OPTIONS };
  process.env.PULLBOARD_RUNNER_SHARED_CACHE = shared;
  delete process.env.NODE_OPTIONS;
  t.after(() => {
    for (const [name, value] of [['PULLBOARD_RUNNER_SHARED_CACHE', saved.shared], ['NODE_OPTIONS', saved.options]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(shared, { recursive: true, force: true });
  });
}

test('codemap.parser-timeout.a-batch-whose-parser-child: clause 1: a batch whose parser child is killed at the timeout is split and still answers every source, timeout unchanged [C7]', t => {
  isolated(t);
  const calls = [];
  const sources = ['import "./a.js";', 'import "./b.js";', 'import "./c.js";', 'import "./d.js";', 'import "./e.js";'];
  const rows = compileSources(sources, scriptedChild(calls));
  assert.deepEqual(rows.map(row => row.imports[0]), sources, 'every source gets its own result, in order');
  assert.ok(calls.some(call => call.count === 5), 'the whole batch was tried first');
  assert.ok(calls.length > 1 && calls.filter(call => call.count === 1).length === 5, 'the halves were retried down to the sources');
  assert.deepEqual([...new Set(calls.map(call => call.timeout))], [10_000], 'no retry waits longer than 10 s');
});

test('codemap.parser-timeout.a-second-sweep-over-unchanged: clause 2: a second sweep over unchanged sources spawns no parser child, every result from the stored cache [C7]', t => {
  isolated(t);
  const calls = [];
  const sources = ['import "./x.js";', 'import "./y.js";'];
  const first = compileSources(sources, scriptedChild(calls));
  const spawned = calls.length;
  assert.ok(spawned > 0, 'the first sweep parsed fresh');
  const second = compileSources(sources, scriptedChild(calls));
  assert.equal(calls.length, spawned, 'the second sweep spawned no child');
  assert.deepEqual(second, first);
});
