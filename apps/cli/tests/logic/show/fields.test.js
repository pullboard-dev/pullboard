/** show's typed fields and related links lines come from one pure function, with the exact text the full path printed before [C7,#9352]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldLines } from '../../../src/logic/show/fields.js';

test('cli.logic-show-fields.field-lines-match-the-recorded-text: clause 1: fieldLines returns the fields block and the related links block exactly as show printed them, and nothing for an empty list [C7,#9352]', () => {
  const fields = [{ name: 'owner', type: 'text', value: 'ana' }, { name: 'size', type: 'number', value: 3 }];
  const links = [{ id: 12, title: 'Another item' }];
  assert.deepEqual(fieldLines(fields, links), [
    'fields:',
    '  owner (text): ana',
    '  size (number): 3',
    'related links:',
    '  #12 Another item',
  ]);
  assert.deepEqual(fieldLines(fields, []), ['fields:', '  owner (text): ana', '  size (number): 3'], 'no links, no links block');
  assert.deepEqual(fieldLines([], links), ['related links:', '  #12 Another item'], 'no fields, no fields block');
  assert.deepEqual(fieldLines([], []), [], 'both empty prints nothing');
});
