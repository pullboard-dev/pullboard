/** Compatibility toggles in the settings inventory carry a removeBy date, refused without one [O6,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingDescriptions } from '../../../index.js';
import { SETTING_DESCRIPTIONS } from '../../../index.js';

test('clause 1: a settings key marked compatibility without a removeBy date is refused, and a dated one carries removeBy in the inventory [O6,C7]', () => {
  const row = ['old.mode', 'Old mode', 'Keeps the old path.', 'Order', 'on/off'];
  for (const toggle of [{ compat: true }, { compat: true, removeBy: '' }, { compat: true, removeBy: 'next release' }]) {
    assert.throws(() => settingDescriptions([[...row, toggle]]), error => error.name === 'Refused' && error.code === 'COMPAT_NEEDS_REMOVE_BY'
      && /old\.mode/u.test(error.message) && /removeBy: 'YYYY-MM-DD'/u.test(error.next), JSON.stringify(toggle));
  }
  const dated = settingDescriptions([[...row, { compat: true, removeBy: '2026-12-31' }], ['plain.key', 'Plain', 'An ordinary setting.', 'Order', 'count']]);
  assert.equal(dated['old.mode'].compat, true);
  assert.equal(dated['old.mode'].removeBy, '2026-12-31');
  assert.equal(dated['plain.key'].removeBy, undefined, 'an ordinary setting carries no removal date');
  const shipped = Object.entries(SETTING_DESCRIPTIONS).filter(([, entry]) => entry.compat);
  assert.ok(shipped.some(([key]) => key === 'gate.runnerDispatch'), 'the runner dispatch toggle is marked compatibility');
  for (const [key, entry] of shipped) assert.match(entry.removeBy, /^\d{4}-\d{2}-\d{2}$/u, key);
});
