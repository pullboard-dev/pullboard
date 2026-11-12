/** @pullboard-test-input source-tree */
/** Item search answers from the last built state and never waits for a newer build [A2,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

const MATERIALIZER = fileURLToPath(new URL('../../../src/io/state/materializer.js', import.meta.url));
/** How long the stub worker takes over each build, standing in for a big board's build. */
const BUILD_MS = 400;

/** The real materializer beside a stub worker whose build n holds one item titled "title n", after BUILD_MS. */
async function stubBoard(t) {
  const files = privateFixtureFiles('pullboard-search-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write('materializer.js', readFileSync(MATERIALIZER));
  files.write('materializer/worker.js', `import { parentPort } from 'node:worker_threads';
let built = 0;
parentPort.on('message', (message) => {
  if (message.type === 'close') return process.exit(0);
  built += 1;
  const sequence = built;
  setTimeout(() => {
    const parts = ['{"unseen":', '}'];
    const variant = { json: parts, validator: parts };
    parentPort.postMessage({ type: 'record', id: message.id, key: message.key, record: { revision: message.revision, sequence, observedAt: Date.now(),
      eventLogVersion: 1, summary: variant, compact: variant, full: null, deltas: {}, shouts: [], search: [['7', 'title ' + sequence]], reportValidator: null } });
  }, ${BUILD_MS});
});
`);
  const { startStateMaterializer } = await import(pathToFileURL(join(files.root, 'materializer.js')).href);
  const watched = { revision: 'r1' };
  const landed = [];
  const heard = new Set();
  const materializer = startStateMaterializer({ portsModule: 'data:text/javascript,', projects: () => [], isMain: true,
    openRevision: () => ({ revision: () => watched.revision }), Refused: class extends Error {},
    onRecord: (record) => { landed.push(record); for (const check of [...heard]) check(); } });
  t.after(() => materializer.close());
  /** Resolve once `count` builds have landed. */
  const built = (count) => new Promise((done) => { const check = () => { if (landed.length >= count) { heard.delete(check); done(); } }; heard.add(check); check(); });
  return { materializer, watched, built, board: { id: 'search', root: '/search' } };
}

test('clause 1: a search after a board change answers from the last build at once, without waiting for a newer build [A2,C7]', async (t) => {
  const { materializer, watched, board } = await stubBoard(t);
  assert.deepEqual(await materializer.search(board, 'title 1'), ['7'], 'the first search waits for the first build');
  watched.revision = 'r2';
  const started = performance.now();
  const ids = await materializer.search(board, 'title 1');
  const ms = performance.now() - started;
  assert.deepEqual(ids, ['7'], 'the search finds the item by the last built title');
  assert.ok(ms < BUILD_MS / 2, `the search took ${ms.toFixed(1)} ms, not a build's ${BUILD_MS} ms`);
});

test('clause 2: a search finds an item\'s new title once the next build lands [A2,C7]', async (t) => {
  const { materializer, watched, built, board } = await stubBoard(t);
  await materializer.search(board, '');
  watched.revision = 'r2';
  assert.deepEqual(await materializer.search(board, 'title 2'), [], 'before the build lands, the old title is searched');
  await built(2);
  assert.deepEqual(await materializer.search(board, 'title 2'), ['7'], 'the build the change started has landed');
  assert.deepEqual(await materializer.search(board, 'title 1'), [], 'the old title is gone');
});
