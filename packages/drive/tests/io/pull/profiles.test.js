/** @pullboard-test-input source-cell packages/drive */
/** A pulled job keeps each phase's timing profile beside its log, as a plain file the phase row names [C7,#7301]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { keepPhaseProfiles } from '../../../src/io/pull/profiles.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

/** A scratch folder for the job and a kept folder for its results, both removed after the test. */
function folders(t) {
  const { root } = privateFixtureFiles('pullboard-profiles-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kept = join(root, 'kept');
  mkdirSync(kept);
  return { scratch: root, kept };
}

test('clause 1: keepPhaseProfiles copies a phase profile into the kept folder as a plain file next to its log [C7,#7301]', t => {
  const { scratch, kept } = folders(t);
  const profile = join(scratch, 'check-1.json');
  writeFileSync(profile, '{"files":[{"file":"a.test.js","seconds":1}]}\n');
  writeFileSync(join(kept, 'check.log'), 'log\n');
  keepPhaseProfiles(kept, [{ name: 'check', kept: 'check.log', profilePath: profile }]);
  const copy = join(kept, 'check-1.json');
  assert.ok(lstatSync(copy).isFile() && !lstatSync(copy).isSymbolicLink(), 'a plain file, not a link');
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(profile, 'utf8'));
  assert.ok(existsSync(profile), 'the original stays where it was');
});

test('clause 2: keepPhaseProfiles sets profileKept to that plain file name [C7,#7301]', t => {
  const { scratch, kept } = folders(t);
  const profile = join(scratch, 'p.json');
  writeFileSync(profile, '{}');
  const rows = keepPhaseProfiles(kept, [{ name: 'proof', kept: 'proof.log', profilePath: profile }]);
  assert.equal(rows[0].profileKept, 'p.json');
  assert.equal(rows[0].name, 'proof', 'the row keeps its other fields');
  assert.ok(existsSync(join(kept, 'p.json')));
});

test('clause 3: a row with no profile or a vanished profile file comes back unchanged and nothing throws [C7,#7301]', t => {
  const { scratch, kept } = folders(t);
  const none = { name: 'a', kept: 'a.log' };
  const gone = { name: 'b', kept: 'b.log', profilePath: join(scratch, 'missing.json') };
  const rows = keepPhaseProfiles(kept, [none, gone]);
  assert.deepEqual(rows, [none, gone]);
  assert.equal(rows[0], none);
  assert.equal(existsSync(join(kept, 'missing.json')), false);
  assert.deepEqual(keepPhaseProfiles(kept, undefined), []);
});
