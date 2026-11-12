/** @pullboard-test-input source-tree */
/** @pullboard-world-pin reads the shipped settings inventory to judge its compatibility toggles. */
/** A compatibility toggle past its removeBy date turns the static checks red with its removal step; the count only falls [O6,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_CHECKS } from '../../../../index.js';
import { INVENTORY_FILE } from '../../../../../config/index.js';

const ROOT = new URL('../../../../../../', import.meta.url);
const SHIPPED = readFileSync(new URL(INVENTORY_FILE, ROOT), 'utf8');
const check = STATIC_CHECKS.find(entry => entry.name === 'compat-toggles');
const row = (key, removeBy) => `  ['${key}', 'Label', 'One sentence.', 'Order', 'on/off', { compat: true${removeBy ? `, removeBy: '${removeBy}'` : ''} }],`;
const inventory = rows => `// rows end { compat: true, removeBy: 'YYYY-MM-DD' }\nconst ROWS = [\n${rows.join('\n')}\n];\n`;
const run = (source, accepted, now) => check.run({ text: () => source, previous: () => accepted, now });

test('clause 2: a toggle past its removeBy date fails the static checks with its removal next step [O6,C7]', () => {
  assert.ok(check, 'the static check registry lists compat-toggles');
  const source = inventory([row('old.mode', '2026-11-10'), row('fresh.mode', '2026-12-31')]);
  const failures = run(source, source, Date.parse('2026-11-11T12:00:00Z'));
  assert.equal(failures.length, 1, failures.join('\n'));
  assert.match(failures[0], new RegExp(`^${INVENTORY_FILE.replaceAll('.', '\\.')}:3: compatibility toggle old\\.mode passed its removeBy date 2026-11-10; next: remove old\\.mode, its reader and its inventory row$`, 'u'));
  assert.deepEqual(run(source, source, Date.parse('2026-11-10T23:59:00Z')), [], 'the removal day itself is still green');
  assert.match(run(inventory([row('undated.mode')]), '', Date.parse('2026-11-11T00:00:00Z'))[0], /undated\.mode has no removeBy date; next: add removeBy/u);
  assert.deepEqual(run(SHIPPED, SHIPPED, Date.parse('2026-11-11T00:00:00Z')), [], 'the shipped inventory is green today');
  assert.deepEqual(check.run({ text: () => { throw new Error('ENOENT'); }, previous: () => '' }), [], 'a project with no inventory has nothing to judge');
});

test('clause 3: the count of compatibility toggles is a ratchet that may only fall against main [O6,C7]', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const two = inventory([row('a.mode', '2026-12-31'), row('b.mode', '2026-12-31')]);
  const three = inventory([row('a.mode', '2026-12-31'), row('b.mode', '2026-12-31'), row('c.mode', '2026-12-31')]);
  assert.match(run(three, two, now).join('\n'), /compatibility toggles grew from 2 to 3; the count only falls; next: remove a toggle before adding one/u);
  assert.deepEqual(run(two, three, now), [], 'removing a toggle is green');
  assert.deepEqual(run(inventory([]), two, now), [], 'removing every toggle is green');
  assert.match(run(inventory([row('a.mode', '2026-12-31')]), inventory([]), now).join('\n'), /grew from 0 to 1/u, 'at zero the ratchet still holds');
  assert.deepEqual(run(three, 'const ROWS = [];\n', now), [], 'main before toggles were tracked does not hold the first marking');
});
