/** The trusted tooling capture is cached by the tooling's tree id: unchanged tooling is not recaptured, changed tooling is [C7,#8133]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { committedRunnerController } from '../../../src/io/tooling/committed.js';
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

/** A second controller process, modelled as a second instance of the tooling module with empty memory. */
async function nextProcess(graph, label) {
  const url = pathToFileURL(join(graph.root, 'packages/runners/src/io/tooling/remote.js')).href;
  return (await import(`${url}?${label}`)).trustedTooling;
}

/** The one saved capture file this fixture's root left under the scratch root. */
function savedFile() {
  const names = readdirSync(tmpdir()).filter(name => name.startsWith('pullboard-trusted-capture-') && name.endsWith('.json'));
  return names.map(name => join(tmpdir(), name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

test('#8291 clause 1: a second fleet trip with an unchanged package reuses the saved capture instead of rescanning [C7]', async t => {
  const { graph, trustedTooling } = await committedTooling(t);
  const first = trustedTooling();
  const file = savedFile();
  t.after(() => rmSync(file, { force: true }));
  // Mark the saved copy, re-sealing its sha256 as a writer of this user's own file could: only a reuse can carry the mark.
  const { body } = JSON.parse(readFileSync(file, 'utf8'));
  const marked = JSON.parse(body);
  marked.captured.tooling.version = 'reused-from-saved';
  const text = JSON.stringify(marked);
  writeFileSync(file, JSON.stringify({ sha256: createHash('sha256').update(text).digest('hex'), body: text }), { mode: 0o600 });
  const second = (await nextProcess(graph, 'trip2'))();
  assert.equal(second.tooling.version, 'reused-from-saved', 'the new process read the saved capture');
  assert.equal(second.tooling.sha256, first.tooling.sha256, 'it is the same tooling bytes');
});

test('#8291 clause 2: a saved capture whose sha256 no longer matches is ignored and recaptured [C7]', async t => {
  const { graph, trustedTooling } = await committedTooling(t);
  const first = trustedTooling();
  const file = savedFile();
  t.after(() => rmSync(file, { force: true }));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...saved, body: saved.body.replace(first.tooling.sha256, '0'.repeat(64)) }), { mode: 0o600 });
  const second = (await nextProcess(graph, 'trip2'))();
  assert.equal(second.tooling.sha256, first.tooling.sha256, 'the tampered file was not believed; the tooling was captured afresh');
  assert.equal(JSON.parse(JSON.parse(readFileSync(file, 'utf8')).body).captured.tooling.sha256, first.tooling.sha256, 'and the good capture was saved over it');
});
