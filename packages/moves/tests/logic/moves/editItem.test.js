/** The editItem move floors its engine at NEEDS_ENGINE when it carries needs [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEEDS_ENGINE } from '../../../../state/light.js';
import editItem from '../../../src/logic/moves/editItem.js';

test('moves.edit-item.needs-floor: clause 2: the editItem descriptor minimumEngine returns at least NEEDS_ENGINE when args[1].needs is set and the same value as today when it is not [C7]', () => {
  assert.ok(editItem.minimumEngine([1, { needs: [] }], null, 0) >= NEEDS_ENGINE, 'empty needs still set the floor');
  assert.ok(editItem.minimumEngine([1, { needs: ['browser'] }], null, 0) >= NEEDS_ENGINE, 'non-empty needs set the floor');
  assert.ok(editItem.minimumEngine([1, { title: 'x' }], null, 0) < NEEDS_ENGINE, 'no needs leaves the floor below NEEDS_ENGINE');
});
