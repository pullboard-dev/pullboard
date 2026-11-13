/** @pullboard-test-input source-tree */
/** The view's own source never says Needs you: the person's decisions are Rulings [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every source file under a folder, as absolute paths. */
function sources(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(folder, entry.name)) : [join(folder, entry.name)]);
}

test('no file under apps/view/src says needs you, in code, markup, styles or comments [N26]', () => {
  const found = sources(SRC).flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((text, index) => /needs[ -]you\b/iu.test(text) ? [file.slice(SRC.length) + ':' + (index + 1)] : []));
  assert.deepEqual(found, [], "the view calls the person's decisions Rulings");
});
