/** The shape rule routes small, proven, briefed work light and everything else strong [C7,#3081]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeRoute } from '../../index.js';

const small = { criterion: '1. Change src/a.js [test]; 2. Prove it in src/a.test.js [test].', check: 'node --test src/a.test.js', brief: 'Files: src/a.js' };

test('clause 1: an item with a check, a brief, 3 tagged clauses and 3 files routes light [C7]', () => {
  assert.equal(shapeRoute(small), 'light');
  assert.equal(shapeRoute({ ...small, criterion: '1. Edit a/a.js [test]\n2. Edit b/b.js [test]\n3. Edit c/c.js [command]' }), 'light');
});

test('clause 1: no check, no brief, a fourth tagged clause or a fourth file routes strong [C7]', () => {
  assert.equal(shapeRoute({ ...small, check: '' }), 'strong');
  assert.equal(shapeRoute({ ...small, brief: '  ' }), 'strong');
  assert.equal(shapeRoute({ ...small, criterion: '1. A [test] 2. B [test] 3. C [test] 4. D [test]' }), 'strong');
  assert.equal(shapeRoute({ ...small, criterion: '1. Edit a/a.js, b/b.js, c/c.js and d/d.js [test]' }), 'strong');
  assert.equal(shapeRoute(), 'strong');
});
