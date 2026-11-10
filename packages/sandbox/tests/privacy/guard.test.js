/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/** View files never quote the owner or name a private machine, and this scan keeps it that way [N26]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SELF = 'packages/sandbox/tests/privacy/guard.test.js';
// The view lane's paths, as `pullboard lanes` prints them.
const VIEW = ['apps/cli/src/io/cockpit.js', 'apps/view', 'test/cockpit.test.js', 'test/cockpit', 'apps/cli/journeys/shout/journeys.test.js'];
// Names written in pieces so this file never contains them whole; the scan also finds the pieces joined.
const NAMES = [['Stu', 'dio'], ['Mac', 'Book'], ['M', 'BP'], ['Cor', 'ey'], ['ol', 'son']].map(parts => parts.join(''));
const PATTERN = new RegExp(`\\b(?:${NAMES.join('|')})\\b|\\(the person,`, 'iu');

/** Every file under a view-lane path, recursively, in a stable order; a missing path has none. */
function filesUnder(path) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).sort().flatMap(name => filesUnder(join(path, name)));
}

test('view files never quote the owner or name a private machine [N26]', () => {
  const scanned = VIEW.flatMap(filesUnder).filter(path => path !== SELF && /\.(?:m?js|css)$/u.test(path));
  assert.ok(scanned.length >= 50, `the scan reads the whole view lane, not ${scanned.length} files`);
  const found = [];
  for (const path of scanned) {
    readFileSync(join(ROOT, path), 'utf8').split('\n').forEach((line, index) => {
      if (PATTERN.test(line)) found.push(`${path}:${index + 1}`);
    });
  }
  assert.deepEqual(found, [], 'remove the attribution or machine name from these lines; reword it so the comment still explains why');
  assert.ok(PATTERN.test('on the ' + NAMES[0]) && PATTERN.test('(the person, 18 Oct)'), 'the pattern catches each kind of mention');
});
