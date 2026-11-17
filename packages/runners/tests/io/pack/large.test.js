/** @pullboard-test-input source-cell packages/runners */
/** A runner history pack streams history whose object list passes 8 MiB, and still scans every object in it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { historyPack } from '../../../src/io/pack.js';
import { MAX_BLOB_BYTES } from '../../../src/io/source/scan.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

/** Files enough that `rev-list --objects` prints more than 8 MiB of object lines. */
const FILES = 36_000;

/**
 * A long, distinct path for file `index`, so each object line is about 280 bytes, spread over 200 folders so that no
 * single tree object nears the 8 MiB per-object scan limit.
 */
function longPath(index) {
  return `history/${'d'.repeat(100)}-${String(index % 200).padStart(3, '0')}/${'p'.repeat(120)}-${String(index).padStart(6, '0')}.txt`;
}

/** A repository whose one commit holds FILES distinct blobs at long paths, written by one fast-import, plus `extra` files. */
function largeHistory(t, extra = {}) {
  const graph = fixtureCommittedGraph('runner-history-large-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('README.md', 'large history fixture\n');
  graph.commit();
  const lines = ['commit refs/heads/main', 'committer Test Agent <agent@example.com> 1700000000 +0000', 'data 6', 'large', 'from refs/heads/main^0'];
  const files = { ...Object.fromEntries(Array.from({ length: FILES }, (_, index) => [longPath(index), `${index}\n`])), ...extra };
  for (const [path, body] of Object.entries(files)) lines.push(`M 100644 inline ${path}`, `data ${Buffer.byteLength(body)}`, body.replace(/\n$/u, ''));
  const imported = runFixtureChild('git', ['fast-import', '--quiet'], { cwd: graph.root, input: `${lines.join('\n')}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
  assert.equal(imported.status, 0, imported.failure);
  const commit = runFixtureGit(['rev-parse', 'refs/heads/main'], { cwd: graph.root });
  return { root: graph.root, commit };
}

/** A private pack directory removed after the test. */
function packDirectory(t) {
  const files = privateFixtureFiles('runner-history-pack-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  return files.root;
}

test('clause 1: history whose object lines pass 8 MiB packs instead of refusing RUNNER_SOURCE [C7]', t => {
  const repo = largeHistory(t);
  const listed = runFixtureChild('git', ['rev-list', '--objects', repo.commit], { cwd: repo.root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
  assert.ok(Buffer.byteLength(listed.stdout) > MAX_BLOB_BYTES, `the fixture lists ${Buffer.byteLength(listed.stdout)} bytes of objects`);
  const directory = packDirectory(t);
  const pack = historyPack(repo.root, { commit: repo.commit }, [], directory);
  assert.ok(statSync(pack).size > 0);
  runFixtureGit(['index-pack', pack], { cwd: repo.root });
  assert.ok(existsSync(pack.replace(/\.pack$/u, '.idx')), 'Git indexes the streamed pack');
  assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('history.')), [], 'the streamed reads leave no files behind');
});

test('clause 2: a private key anywhere in that large history still refuses RUNNER_SECRET [C7]', t => {
  const header = ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' ');
  const repo = largeHistory(t, { [longPath(FILES)]: `${header}\nnot a real key\n` });
  const directory = packDirectory(t);
  assert.throws(() => historyPack(repo.root, { commit: repo.commit }, [], directory), { code: 'RUNNER_SECRET' });
  assert.equal(existsSync(join(directory, 'source.pack')), false, 'no pack is written for refused history');
});
