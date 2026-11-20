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

test('state.logic-bar-lint.check-names-no-test-file: clause 1: lintBar warns BAR_CHECK_NO_TEST naming the clause when a [test] clause has a check naming no .test.js file, and is quiet when the check names one or no clause is tagged [test] [C7]', () => {
  const checked = (bar, check) => lintBar(bar, { check }).warnings.filter(warning => warning.code === 'BAR_CHECK_NO_TEST');
  const [warning] = checked('1. the page shows the title [test]', 'git grep -n title -- apps/page.js');
  assert.equal(warning.clause, 1);
  assert.match(warning.message, /clause 1/u);
  assert.deepEqual(checked('1. the page shows the title [test]', 'node packages/gate/src/io/run/tests.js apps/page.test.js'), []);
  assert.deepEqual(checked('1. the page shows the title [command]', 'git grep -n title -- apps/page.js'), []);
  assert.deepEqual(checked('1. the page shows the title [test]', undefined), []);
});
