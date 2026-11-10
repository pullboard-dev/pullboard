/** A red publish holds only the items whose diff touches a file it names; an unnamed red still pauses all landing [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishRedHold } from '../../src/io/pause.js';
import { publishRedTouched } from '../../src/io/pause.js';

const red = { head: 'abc123', failures: [{ file: 'test/f.test.js', name: 'f case' }] };
const state = { red: 'abc123', failures: [{ file: 'test/f.test.js', name: 'f case', items: [7] }] };

test('clause 1: requirePublishGreen excludes only items whose diff touches a file named in publish.json failures and other verified items land [C7]', () => {
  const hold = publishRedHold(state, red);
  assert.deepEqual(hold.files, ['test/f.test.js'], 'the red names its file');
  assert.equal(hold.refusal.code, 'PUBLISH_RED');
  const items = new Map([[1, ['src/a.js', 'test/f.test.js']], [2, ['src/b.js']], [3, ['docs/c.md']]]);
  const held = [...items].filter(([, changed]) => publishRedTouched(hold.files, changed).length).map(([id]) => id);
  const landing = [...items].filter(([, changed]) => !publishRedTouched(hold.files, changed).length).map(([id]) => id);
  assert.deepEqual(held, [1], 'only the item touching the named file is held');
  assert.deepEqual(landing, [2, 3], 'unrelated verified items still land');
});

test('clause 2: a red publish with no file names still pauses all landing and says why [C7]', () => {
  const hold = publishRedHold({ red: 'abc123', failures: [] }, { head: 'abc123', failures: [{ name: 'unnamed case' }] });
  assert.deepEqual(hold.files, [], 'no file names means no per-item exclusion, so the full pause stays');
  assert.equal(hold.refusal.code, 'PUBLISH_RED');
  assert.match(hold.refusal.message, /landing pauses until a later full suite passes/u);
  assert.match(hold.refusal.message, /unnamed case/u);
});
