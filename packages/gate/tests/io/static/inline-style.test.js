/** The static checks refuse a new inline style in the view, naming file and line, and let existing sites stay [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATIC_CHECKS } from '../../../heavy.js';
import { inlineStyleProblems } from '../../../src/io/static/inline-style.js';

const check = STATIC_CHECKS.find(row => row.name === 'inline-style');

/** Run the registered check on one view file whose accepted text on main was `before`. */
function judge(file, before, after) {
  return check.run({ root: '.', files: [file], text: () => after, previous: () => before });
}

test('gate.io-static-inline-style.a-new-style-attribute-element-style: clause 1: a new style= attribute, element.style write or style.setProperty in apps/view fails, naming file and line [C7]', () => {
  const file = 'apps/view/src/io/page/new.js';
  assert.deepEqual(judge(file, '', "const a = 1;\nconst html = `<div style=\"width:3px\"></div>`;\n").map(row => row.slice(0, file.length + 3)), [`${file}:2:`]);
  assert.equal(judge(file, '', "node.style.top = '1px';\n").length, 1);
  assert.equal(judge(file, '', "node.style.setProperty('--x', '1');\n").length, 1);
  assert.equal(judge(file, '', "node.style.removeProperty('top');\n").length, 1);
  assert.equal(judge(file, '', "node.setAttribute('style', 'top:1px');\n").length, 1);
});

test('gate.io-static-inline-style.a-file-keeps-the-sites-main: clause 1: a file keeps the sites main already has, and tests, comments and comparisons are not sites [C7]', () => {
  const file = 'apps/view/src/io/page/old.js';
  const old = "node.style.top = '1px';\n";
  assert.deepEqual(judge(file, old, old + 'const same = 1;\n'), []);
  assert.equal(judge(file, old, old + "node.style.left = '2px';\n").length, 1);
  assert.deepEqual(judge(file, '', "// node.style.top = '1px'\nif (rule.style === 'versioned') {}\nconst note = 'styles';\n"), []);
  assert.deepEqual(inlineStyleProblems('.', ['apps/view/tests/io/x.test.js', 'packages/gate/src/x.js'], () => "a.style.top = '1';\n"), []);
});
