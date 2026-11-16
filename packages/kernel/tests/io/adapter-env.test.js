/** The environment adapter returns the injected source, or the real one by default [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { environmentAdapter } from '../../src/io/env.js';

test('clause 1: the adapter returns what the injected source returns [C7]', () => {
  const env = environmentAdapter({ A: 'one', B: undefined });
  assert.equal(env.get('A'), 'one');
  assert.equal(env.get('B', 'fb'), 'fb');
  assert.equal(env.has('A'), true);
  assert.equal(env.has('B'), false);
  assert.deepEqual(env.all(), { A: 'one', B: undefined });
});

test('clause 1: the adapter reads the real source by default [C7]', () => {
  const key = 'PULLBOARD_ADAPTER_ENV_PROBE';
  const before = process.env[key];
  process.env[key] = 'real';
  try {
    assert.equal(environmentAdapter().get(key), 'real');
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

test('clause 1: a fake source makes the answer deterministic [C7]', () => {
  const fake = { HOME: '/fake/home' };
  assert.equal(environmentAdapter(fake).get('HOME'), '/fake/home');
  fake.HOME = '/other';
  assert.equal(environmentAdapter(fake).get('HOME'), '/other');
});

test('clause 2: nothing outside packages/kernel imports the adapter yet [C7]', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const hits = spawnSync('git', ['grep', '-l', 'environmentAdapter', '--', '.', ':!packages/kernel'], { cwd: root, encoding: 'utf8' });
  assert.equal(hits.stdout.trim(), '', 'no importer outside the kernel');
});
