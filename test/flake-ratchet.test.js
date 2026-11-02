/** Quarantine counts are a per-landing ratchet, with named flake evidence [C7,T12]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flakeRatchet, pairedFlakeObservations } from '../packages/flakes/index.js';

const observed = (file, eventId) => ({ file, name: 'case', status: 'active', count: 1, lastEventId: eventId });
const quarantine = (file, item, eventId) => ({ file, name: 'case', status: 'quarantined', item, eventId });

test('a new unquarantined flake refuses the landing by test name [C7,T12]', () => {
  const result = flakeRatchet({ previous: { version: 1, eventId: 10, quarantines: [] }, eventId: 12,
    observations: [observed('test/new.test.js', 11)], quarantines: [] });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.unprotected, [{ file: 'test/new.test.js', name: 'case' }]);
});

test('a filed newly observed quarantine can raise the count, and repair lowers it [C7,T12]', () => {
  const previous = { version: 1, eventId: 10, quarantines: [] };
  const first = flakeRatchet({ previous, eventId: 13, observations: [observed('test/new.test.js', 11)],
    quarantines: [quarantine('test/new.test.js', 7, 12)] });
  assert.equal(first.allowed, true);
  assert.equal(first.snapshot.quarantines.length, 1);
  const fixed = flakeRatchet({ previous: first.snapshot, eventId: 15, observations: [], quarantines: [] });
  assert.equal(fixed.allowed, true);
  assert.equal(fixed.snapshot.quarantines.length, 0);
});

test('old or unfiled quarantine cannot justify increasing the landing baseline [C7,T12]', () => {
  const previous = { version: 1, eventId: 10, quarantines: [] };
  const old = flakeRatchet({ previous, eventId: 12, observations: [observed('test/old.test.js', 9)],
    quarantines: [quarantine('test/old.test.js', 4, 11)] });
  assert.equal(old.allowed, false);
  assert.deepEqual(old.unjustified, [{ file: 'test/old.test.js', name: 'case' }]);
  const missing = flakeRatchet({ previous, eventId: 12, observations: [observed('test/new.test.js', 11)],
    quarantines: [quarantine('test/new.test.js', null, 12)] });
  assert.equal(missing.allowed, false);
});

/** Quarantine's native source is a pair of actual verdicts on the same tree. */
test('native paired test verdicts identify new flakes without mixing trees [C7,T12]', () => {
  const run = (id, eventId, tree, passed, extra = {}) => ({ id, eventId, tree, version: 1, kind: 'landing',
    testOutcomes: [{ file: 'test/a.test.js', name: 'case', passed, skipped: false }], ...extra });
  const red = run('red', 5, 'tree-a', false), green = run('green', 8, 'tree-a', true);
  assert.deepEqual(pairedFlakeObservations([red, run('other', 6, 'tree-b', true)]), []);
  assert.deepEqual(pairedFlakeObservations([red, green], { afterEvent: 6 }), [observed('test/a.test.js', 8)]);
  assert.deepEqual(pairedFlakeObservations([red, green], { afterEvent: 8 }), []);
  assert.deepEqual(pairedFlakeObservations([red, { ...green, id: 'red' }]), []);
});
