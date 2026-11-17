/** The environment adapter returns the injected source, or the real one by default [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as light from '../../light.js';
import { environmentAdapter } from '../../src/io/env.js';

test('kernel.adapter-env.returns-the-source: clause 1: the adapter returns what the injected source returns [C7]', () => {
  const env = environmentAdapter({ A: 'one', B: undefined });
  assert.equal(env.get('A'), 'one');
  assert.equal(env.get('B', 'fb'), 'fb');
  assert.equal(env.has('A'), true);
  assert.equal(env.has('B'), false);
  assert.deepEqual(env.all(), { A: 'one', B: undefined });
});

test('kernel.adapter-env.real-by-default: clause 1: the adapter reads the real source by default [C7]', () => {
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

test('kernel.adapter-env.fake-is-deterministic: clause 1: a fake source makes the answer deterministic [C7]', () => {
  const fake = { HOME: '/fake/home' };
  assert.equal(environmentAdapter(fake).get('HOME'), '/fake/home');
  fake.HOME = '/other';
  assert.equal(environmentAdapter(fake).get('HOME'), '/other');
});

test('kernel.adapter-env.not-imported-outside: clause 2: the runner light door does not export the adapter, so no existing behaviour changes [C7]', () => {
  assert.equal('environmentAdapter' in light, false);
  assert.equal(typeof environmentAdapter, 'function');
});
