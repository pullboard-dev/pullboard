/** @pullboard-test-input source-cell apps/cli */
/**
 * The view needs reader and the files it imports under the view app reach no view server module, so pullboard status never loads the view server [C7].
 * Why static: the modules a command loads are the ones its import statements name, so no process is launched.
 * The view's files come from the codemap source inventory, so this test reads no view file by path.
 */
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { test } from 'node:test';
import { styleSources } from '../../../../../../packages/codemap/index.js';

const REPO = new URL('../../../../../..', import.meta.url).pathname;
const SOURCES = new Map(styleSources(REPO).map(row => [row.file, row.source]));
const ENTRIES = ['apps/view/src/io/needs.js', 'apps/view/src/logic/needs/summary.js', 'apps/view/src/logic/resume.js'];
/** Server modules of the view app: the files that open a port or build the request handler. */
const SERVER = ['apps/view/src/io/serve.js'];

/** The relative specifiers a source names, static or dynamic. */
function specifiers(source) {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)'(\.{1,2}\/[^']*)'/gu)].map(match => match[1]);
}

/** Every file under the view app reachable from `entries` through relative imports, with the file that names it. */
function reachable(entries) {
  const seen = new Map(), queue = entries.map(entry => [entry, 'entry']);
  while (queue.length > 0) {
    const [file, from] = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, from);
    for (const specifier of specifiers(SOURCES.get(file) ?? '')) {
      const target = posix.join(posix.dirname(file), specifier);
      if (target.startsWith('apps/view/') && target.endsWith('.js')) queue.push([target, file]);
    }
  }
  return seen;
}

test('cli.io-commands-status-doors-view-state.the-view-needs-reader-and-its-relative: clause 1: the view needs reader and its relative imports under the view app reach no view server module [C7]', () => {
  for (const entry of ENTRIES) assert.ok(SOURCES.has(entry), `${entry} is not in the source inventory`);
  const found = reachable(ENTRIES);
  assert.ok(found.size > ENTRIES.length, 'the walk followed no import');
  for (const server of SERVER) assert.ok(!found.has(server), `${server} is reached from ${found.get(server)}`);
  assert.ok(found.has('apps/view/src/io/state.js'), 'needs.js no longer reads projectState from state.js');
});
