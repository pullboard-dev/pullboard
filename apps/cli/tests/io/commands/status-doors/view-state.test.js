/** @pullboard-test-input source-cell apps/cli apps/view */
/**
 * The view needs reader and the files it imports under the view app reach no view server module, so pullboard status never loads the view server [C7].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../../../../..');
const VIEW = resolve(REPO, 'apps/view');
const ENTRIES = ['apps/view/src/io/needs.js', 'apps/view/src/logic/needs/summary.js', 'apps/view/src/logic/resume.js'];
/** Server modules of the view app: the files that open a port or build the request handler. */
const SERVER = ['apps/view/src/io/serve.js'];

/** The relative specifiers a file names, static or dynamic. */
function specifiers(file) {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)'(\.{1,2}\/[^']*)'/gu)].map(match => match[1]);
}

/** Every file under the view app reachable from `entries` through relative imports, with the file that names it. */
function reachable(entries) {
  const seen = new Map(), queue = entries.map(entry => [resolve(REPO, entry), 'entry']);
  while (queue.length > 0) {
    const [file, from] = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, from);
    if (!existsSync(file)) continue;
    for (const specifier of specifiers(file)) {
      const target = resolve(dirname(file), specifier);
      if (target.startsWith(VIEW + '/') && target.endsWith('.js')) queue.push([target, relative(REPO, file)]);
    }
  }
  return seen;
}

test('clause 1: the view needs reader and its relative imports under the view app reach no view server module [C7]', () => {
  const found = reachable(ENTRIES);
  assert.ok(found.size > ENTRIES.length, 'the walk followed no import');
  for (const server of SERVER) {
    const file = resolve(REPO, server);
    assert.ok(!found.has(file), `${server} is reached from ${found.get(file)}`);
  }
  assert.ok(found.has(resolve(REPO, 'apps/view/src/io/state.js')), 'needs.js no longer reads projectState from state.js');
});
