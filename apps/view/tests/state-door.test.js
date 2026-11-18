/** @pullboard-test-input apps/view/src/** */
/** The needs reader takes projectState from a module that loads no server [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const viewDir = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(viewDir, 'src') + '/';
const serveFile = join(srcDir, 'io', 'serve.js');

/** Every file under apps/view/src that `start` reaches by relative import, itself included. */
function reached(start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      const target = resolve(dirname(file), match[1]);
      if (target.startsWith(srcDir)) queue.push(target);
    }
  }
  return seen;
}

test('view.x-state-door.clause-1-the-needs-reader-summary-and: clause 1: the needs reader, summary and resume reach no import of serve.js, and state.js projectState is the one serve.js exports [C7]', async () => {
  for (const entry of ['io/needs.js', 'logic/needs/summary.js', 'logic/resume.js']) {
    const files = reached(join(srcDir, entry));
    assert.ok(files.has(join(srcDir, entry)), `${entry} was read`);
    assert.equal(files.has(serveFile), false, `${entry} reaches no import of apps/view/src/io/serve.js`);
  }
  assert.ok(reached(join(srcDir, 'io', 'needs.js')).has(join(srcDir, 'io', 'state.js')), 'the needs reader takes projectState from state.js');
  const state = await import(pathToFileURL(join(srcDir, 'io', 'state.js')).href);
  const serve = await import(pathToFileURL(serveFile).href);
  assert.equal(typeof state.projectState, 'function');
  assert.equal(serve.projectState, state.projectState);
});
