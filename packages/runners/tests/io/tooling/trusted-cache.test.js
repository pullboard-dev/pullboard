/** The trusted tooling capture is cached by the tooling's tree id: unchanged tooling is not recaptured, changed tooling is [C7,#8133]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { fixtureCommittedGraph } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { copyRunnerPackage } from '../../fixtures/package.js';

const SOURCE = fileURLToPath(new URL('../../../../../', import.meta.url));
const WORKER = 'apps/runner/src/io/scripts/worker.js';

/** A committed private copy of the runner package, with its own tooling module loaded from that copy so its root is the copy. */
async function committedTooling(t) {
  const graph = fixtureCommittedGraph('pullboard-trusted-cache-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  copyRunnerPackage(SOURCE, graph.root);
  graph.commit();
  const { trustedTooling } = await import(pathToFileURL(join(graph.root, 'packages/runners/index.js')).href);
  return { graph, trustedTooling };
}

test('#8133 clause 1: a second capture of the same tooling tree reuses the first, without rescanning the worker files [C7]', async t => {
  const { graph, trustedTooling } = await committedTooling(t);
  const first = trustedTooling();
  assert.equal(first.tooling.kind, 'git-checkout', 'the copy is captured from its committed export');
  // An uncommitted edit is not a change of tree: the capture came from the committed tree, so it still answers.
  appendFileSync(join(graph.root, WORKER), '// uncommitted\n');
  const second = trustedTooling();
  assert.equal(second, first, 'the same tree answers from the held capture, not a new scan');
});

test('#8133 clause 2: a changed tooling tree is captured afresh [C7]', async t => {
  const { graph, trustedTooling } = await committedTooling(t);
  const first = trustedTooling();
  appendFileSync(join(graph.root, WORKER), '// changed tooling\n');
  graph.commit();
  const second = trustedTooling();
  assert.notEqual(second, first, 'a new tree is not answered from the old capture');
  assert.notEqual(second.tooling.tree, first.tooling.tree);
  assert.notEqual(second.tooling.sha256, first.tooling.sha256, 'the new capture carries the changed worker bytes');
  assert.equal(trustedTooling(), second, 'and the new tree is then held in turn');
});
