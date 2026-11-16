/** The trusted tooling capture is cached by the tooling's tree id: unchanged tooling is not recaptured, changed tooling is [C7,#8133]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { committedTooling } from '../../fixtures/trusted-tooling.js';

const WORKER = 'apps/runner/src/io/scripts/worker.js';

test('#8133 clause 1: a second capture of the same tooling tree reuses the first, without rescanning the worker files [C7]', async t => {
  const { graph, trustedTooling } = await committedTooling(t, fixtureCommittedGraph('pullboard-trusted-cache-'));
  const first = trustedTooling();
  assert.equal(first.tooling.kind, 'git-checkout', 'the copy is captured from its committed export');
  // An uncommitted edit is not a change of tree: the capture came from the committed tree, so it still answers.
  appendFileSync(join(graph.root, WORKER), '// uncommitted\n');
  const second = trustedTooling();
  assert.equal(second, first, 'the same tree answers from the held capture, not a new scan');
});

test('#8133 clause 2: a changed tooling tree is captured afresh [C7]', async t => {
  const { graph, trustedTooling } = await committedTooling(t, fixtureCommittedGraph('pullboard-trusted-cache-'));
  const first = trustedTooling();
  appendFileSync(join(graph.root, WORKER), '// changed tooling\n');
  graph.commit();
  const second = trustedTooling();
  assert.notEqual(second, first, 'a new tree is not answered from the old capture');
  assert.notEqual(second.tooling.tree, first.tooling.tree);
  assert.notEqual(second.tooling.sha256, first.tooling.sha256, 'the new capture carries the changed worker bytes');
  assert.equal(trustedTooling(), second, 'and the new tree is then held in turn');
});
