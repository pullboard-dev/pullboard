/** A routed add with no brief section is refused NO_BRIEF with the exact accepted brief shape [C7,#11949]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRouted } from '../../index.js';

const base = { route: 'mid', criterion: '1. Change src/a.js [test]', check: 'node --test' };

test('items.routing.no-brief-shows-the-shape: clause 1: a mid-routed add with no Files section is refused NO_BRIEF with a message containing a Files: line, a path on its own line and a Test: line, naming the missing section [C7,#11949]', () => {
  assert.throws(() => checkRouted({ ...base, brief: 'Test: what the test asserts' }, 1), error => {
    assert.equal(error.code, 'NO_BRIEF');
    assert.match(error.message, /needs a brief with a Files: section naming the paths to touch/u);
    assert.match(error.message, /^Files:$/mu);
    assert.match(error.message, /^path\/to\/file\.js$/mu);
    assert.match(error.message, /^Test:$/mu);
    return true;
  });
});

test('items.routing.no-shape-when-only-a-flag-is-missing: clause 1: a refusal that names only a missing flag does not append the brief shape [C7,#11949]', () => {
  const brief = 'Files:\n- src/a.js\n\nTest: src/a.test.js';
  assert.throws(() => checkRouted({ ...base, brief, check: '' }, 1), error => {
    assert.equal(error.code, 'NO_BRIEF');
    assert.match(error.message, /--check, the command that proves it/u);
    assert.doesNotMatch(error.message, /brief shape is/u);
    return true;
  });
});
