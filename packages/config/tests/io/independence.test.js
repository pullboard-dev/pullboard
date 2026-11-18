/** @pullboard-test-loads packages/config/src/io/main.js */
/** review.independence is off by default and accepts only off or session [V1,B3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../src/io/main.js';

test('config.io-independence.review-independence-defaults-to-off-and: review.independence defaults to off and accepts session, keeping starveMinutes [V1,B3]', () => {
  assert.equal(configFromSource('{}').review.independence, 'off');
  assert.equal(configFromSource('{"review":{"independence":"session"}}').review.independence, 'session');
  assert.equal(configFromSource('{"review":{"independence":"session"}}').review.starveMinutes, 5);
});

test('config.io-independence.review-independence-refuses-any-other: review.independence refuses any other value by name [V1,B3]', () => {
  assert.throws(() => configFromSource('{"review":{"independence":"strict"}}'), { code: 'BAD_CONFIG', message: /review\.independence/u });
});
