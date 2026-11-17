/** The trusted tooling capture is cached by the tooling's tree id: unchanged tooling is not recaptured, changed tooling is [C7,#8133]. */
import { after } from 'node:test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { sharedCommittedTooling } from '../../fixtures/trusted-tooling.js';

const WORKER = 'apps/runner/src/io/scripts/worker.js';

/** One committed copy of the runner package serves both cases (case 1 restores its uncommitted edit; case 2 then commits its own). */
const shared = () => sharedCommittedTooling(() => fixtureCommittedGraph('pullboard-trusted-cache-'));
after(async () => (await shared()).remove());

test('runners.trusted-cache.n8133-clause-1-a-second-capture: #8133 clause 1: a second capture of the same tooling tree reuses the first, without rescanning the worker files [C7]', async () => {
  const { graph, trustedTooling } = await shared();
  const first = trustedTooling();
  assert.equal(first.tooling.kind, 'git-checkout', 'the copy is captured from its committed export');
  // An uncommitted edit is not a change of tree: the capture came from the committed tree, so it still answers.
  const worker = join(graph.root, WORKER), original = readFileSync(worker);
  appendFileSync(worker, '// uncommitted\n');
  const second = trustedTooling();
  writeFileSync(worker, original);
  assert.equal(second, first, 'the same tree answers from the held capture, not a new scan');
});

test('runners.trusted-cache.n8133-clause-2-a-changed-tooling: #8133 clause 2: a changed tooling tree is captured afresh [C7]', async () => {
  const { graph, trustedTooling } = await shared();
  const first = trustedTooling();
  appendFileSync(join(graph.root, WORKER), '// changed tooling\n');
  graph.commit();
  const second = trustedTooling();
  assert.notEqual(second, first, 'a new tree is not answered from the old capture');
  assert.notEqual(second.tooling.tree, first.tooling.tree);
  assert.notEqual(second.tooling.sha256, first.tooling.sha256, 'the new capture carries the changed worker bytes');
  assert.equal(trustedTooling(), second, 'and the new tree is then held in turn');
});
