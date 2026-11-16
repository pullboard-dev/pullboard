/** A runner work dir without .git reuses or recaptures the saved trusted capture; split from trusted-cache.test.js for its file budget [C7,#8426,#8502]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

/** The one saved capture file this fixture's root left under the scratch root. */
function savedFile() {
  const names = readdirSync(tmpdir()).filter(name => name.startsWith('pullboard-trusted-capture-') && name.endsWith('.json'));
  return names.map(name => join(tmpdir(), name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** An unpacked export of the committed copy with no .git, as a runner job's work dir is, and its tooling module loader. */
async function exportedTooling(t) {
  const { graph } = await committedTooling(t);
  const exported = committedRunnerController(graph.root);
  t.after(() => exported.cleanup());
  assert.equal(existsSync(join(exported.root, '.git')), false, 'a runner work dir has no .git');
  const url = pathToFileURL(join(exported.root, 'packages/runners/src/io/tooling/remote.js')).href;
  // A runner's controller pins its own loaded bytes at start, as every process there does, before it captures them.
  return async label => { const module = await import(`${url}?${label}`); module.pinRunnerTooling(); return module.trustedTooling; };
}

test('#8426 clause 1: a second trip in a work dir without .git reuses the saved capture [C7]', async t => {
  const tooling = await exportedTooling(t);
  const first = (await tooling('trip1'))();
  const file = savedFile();
  t.after(() => rmSync(file, { force: true }));
  const { body } = JSON.parse(readFileSync(file, 'utf8'));
  const marked = JSON.parse(body);
  marked.captured.tooling.version = 'reused-from-saved';
  const text = JSON.stringify(marked);
  writeFileSync(file, JSON.stringify({ sha256: createHash('sha256').update(text).digest('hex'), body: text }), { mode: 0o600 });
  const second = (await tooling('trip2'))();
  assert.equal(second.tooling.version, 'reused-from-saved', 'the new process read the saved capture');
  assert.equal(second.tooling.sha256, first.tooling.sha256, 'it is the same tooling bytes');
});

test('#8426 clause 2: a saved capture whose sha256 no longer matches is recaptured in a work dir without .git [C7]', async t => {
  const tooling = await exportedTooling(t);
  const first = (await tooling('trip1'))();
  const file = savedFile();
  t.after(() => rmSync(file, { force: true }));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...saved, body: saved.body.replace(first.tooling.sha256, '0'.repeat(64)) }), { mode: 0o600 });
  const second = (await tooling('trip2'))();
  assert.equal(second.tooling.sha256, first.tooling.sha256, 'the tampered file was not believed; the tooling was captured afresh');
  assert.equal(JSON.parse(JSON.parse(readFileSync(file, 'utf8')).body).captured.tooling.sha256, first.tooling.sha256, 'and the good capture was saved over it');
});
