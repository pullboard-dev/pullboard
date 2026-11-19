/** The addItem move floors its engine at NEEDS_ENGINE when it carries needs [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEEDS_ENGINE } from '../../../../state/light.js';
import addItem from '../../../src/logic/moves/addItem.js';

test('moves.add-item.needs-floor: clause 1: the addItem descriptor minimumEngine returns at least NEEDS_ENGINE when args[0].needs is set and the same value as today when it is not [C7]', () => {
  assert.ok(addItem.minimumEngine([{ title: 'x', needs: [] }], null, 0) >= NEEDS_ENGINE, 'empty needs still set the floor');
  assert.ok(addItem.minimumEngine([{ title: 'x', needs: ['browser'] }], null, 0) >= NEEDS_ENGINE, 'non-empty needs set the floor');
  assert.ok(addItem.minimumEngine([{ title: 'x' }], null, 0) < NEEDS_ENGINE, 'no needs leaves the floor below NEEDS_ENGINE');
});
