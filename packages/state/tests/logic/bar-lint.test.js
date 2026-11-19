/** The bar lint's BAR_TWO_FACTS warns on an "and" that joins two facts and stays quiet on one that joins two nouns in one fact [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintBar } from '../../src/logic/bar-lint.js';

const codes = bar => lintBar(bar).warnings.map(warning => warning.code);

test('state.bar-lint.single-fact-and-quiet: clause 1: lintBar on the plan skill template clause returns no BAR_TWO_FACTS warning [C7]', () => {
  assert.deepEqual(codes('1. packages/web/tests/handler.test.js has one case per public method and documented behavior of packages/web/src/handler.js, all green [test]'), []);
  assert.deepEqual(codes('1. the page shows the title and subtitle [test]'), []);
});

test('state.bar-lint.two-facts-still-warn: clause 2: lintBar on a clause whose and joins two results still returns BAR_TWO_FACTS [C7]', () => {
  assert.deepEqual(codes('1. it returns the id and writes the file [test]'), ['BAR_TWO_FACTS']);
  assert.deepEqual(codes('1. it exits 0 and is quiet [test]'), ['BAR_TWO_FACTS']);
});
