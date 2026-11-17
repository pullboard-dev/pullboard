/** @pullboard-test-input source-cell packages/runners */
/** The trusted tooling capture saved for a second fleet trip is reused when intact and ignored when tampered [C7,#8291]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { committedTooling } from '../../fixtures/trusted-tooling.js';

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
  const { graph, trustedTooling } = await committedTooling(t, fixtureCommittedGraph('pullboard-trusted-cache-'));
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
  const { graph, trustedTooling } = await committedTooling(t, fixtureCommittedGraph('pullboard-trusted-cache-'));
  const first = trustedTooling();
  const file = savedFile();
  t.after(() => rmSync(file, { force: true }));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...saved, body: saved.body.replace(first.tooling.sha256, '0'.repeat(64)) }), { mode: 0o600 });
  const second = (await nextProcess(graph, 'trip2'))();
  assert.equal(second.tooling.sha256, first.tooling.sha256, 'the tampered file was not believed; the tooling was captured afresh');
  assert.equal(JSON.parse(JSON.parse(readFileSync(file, 'utf8')).body).captured.tooling.sha256, first.tooling.sha256, 'and the good capture was saved over it');
});
