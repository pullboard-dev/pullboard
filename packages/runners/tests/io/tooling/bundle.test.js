/** The worker bundle is cached by tooling digest: a new commit with the same tooling reuses it, a bad bundle is rebuilt [C7,#8462]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { copyRunnerPackage } from '../../fixtures/package.js';

const SOURCE = fileURLToPath(new URL('../../../../../', import.meta.url));
const WORKER = 'apps/runner/src/io/scripts/worker.js';
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** A committed private copy of the runner package, and a loader for a fresh controller process (empty module memory) on it. */
function committedCopy(t) {
  const graph = fixtureCommittedGraph('pullboard-tooling-bundle-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  copyRunnerPackage(SOURCE, graph.root);
  graph.commit();
  const url = pathToFileURL(join(graph.root, 'packages/runners/src/io/tooling/remote.js')).href;
  const trip = async label => (await import(`${url}?${label}`)).trustedTooling();
  return { graph, trip };
}

/** The bundle file of one tooling digest; removed after the test with this root's pointer. */
function bundleFile(t, root, digest) {
  const file = join(tmpdir(), `pullboard-tooling-bundle-${digest}.json`);
  const pointer = join(tmpdir(), `pullboard-tooling-bundle-latest-${sha256(root).slice(0, 32)}`);
  t.after(() => { rmSync(file, { force: true }); rmSync(pointer, { force: true }); });
  return file;
}

/** Re-seal a bundle with its tooling version replaced by a mark, as a writer of this user's own file could: only a reuse carries it. */
function markBundle(file) {
  const saved = JSON.parse(JSON.parse(readFileSync(file, 'utf8')).body);
  saved.captured.tooling.version = 'reused-from-bundle';
  const body = JSON.stringify(saved);
  writeFileSync(file, JSON.stringify({ sha256: sha256(body), body }), { mode: 0o600 });
}

test('runners.bundle.n8462-clause-1-a-second-trip: #8462 clause 1: a second trip on a new commit with the same tooling digest starts the cached bundle without rebuilding it [C7]', async t => {
  const { graph, trip } = committedCopy(t);
  const first = await trip('trip1');
  const file = bundleFile(t, graph.root, first.tooling.sha256);
  markBundle(file);
  // A landing that touches no tooling byte: a new commit and tree, so the commit-keyed capture has nothing for it.
  writeFileSync(join(graph.root, 'NOTES.md'), 'not tooling\n');
  const commit = graph.commit();
  const second = await trip('trip2');
  assert.equal(second.tooling.version, 'reused-from-bundle', 'the trip started the cached bundle instead of rebuilding and re-parsing the closure');
  assert.equal(second.tooling.sha256, first.tooling.sha256, 'the same tooling digest');
  assert.equal(second.tooling.commit, commit, 'the receipt binding names the new commit, as a fresh capture would');
  assert.notEqual(second.tooling.tree, first.tooling.tree);
  assert.deepEqual(second.runtime, first.runtime, 'the same worker runtime bytes');
});

test('runners.bundle.n8462-clause-2-a-cached-bundle: #8462 clause 2: a cached bundle whose hash no longer matches is rebuilt [C7]', async t => {
  const { graph, trip } = committedCopy(t);
  const first = await trip('trip1');
  const file = bundleFile(t, graph.root, first.tooling.sha256);
  const sealed = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...sealed, body: sealed.body.replace(first.tooling.version, 'reused-from-bundle') }), { mode: 0o600 });
  writeFileSync(join(graph.root, 'NOTES.md'), 'not tooling\n');
  const commit = graph.commit();
  const second = await trip('trip2');
  assert.equal(second.tooling.version, first.tooling.version, 'the tampered bundle was not believed; the closure was rebuilt');
  assert.equal(second.tooling.commit, commit);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sha256, sha256(JSON.parse(readFileSync(file, 'utf8')).body), 'and a good bundle was saved over it');
  // A bundle whose files differ at the new commit is not the new tooling: the changed worker is rebuilt under a new digest.
  appendFileSync(join(graph.root, WORKER), '// changed tooling\n');
  graph.commit();
  const third = await trip('trip3');
  bundleFile(t, graph.root, third.tooling.sha256);
  assert.notEqual(third.tooling.sha256, first.tooling.sha256, 'the changed worker bytes are a new digest');
  assert.match(third.worker, /\/\/ changed tooling\n$/u, 'built from the new commit, not the cached bundle');
});
