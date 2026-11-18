/** A runner history pack skips the secret scan only for the exact listed historical blobs, by full id [C7,#7919]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { historyPack } from '../../../src/io/pack.js';
import { historicalScanExempt } from '../../../src/io/source/scan.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';

/** The upgrade fixture board path the listed blobs were committed at. */
const FIXTURE = 'apps/cli/tests/fixtures/upgrade-093/board.sqlite';

/** One listed blob: an old version of the fixture board whose only scan hits are random lease fencing tokens. */
const LISTED = '04f366c14bcff002de322adaa655d93f4a64477f';

/** The listed blob's exact bytes, read from this repository's own history. */
function listedBytes() {
  const read = runFixtureChild('git', ['cat-file', 'blob', LISTED], { cwd: resolve(import.meta.dirname, '../../../../..'), maxBuffer: 16 * 1024 ** 2 });
  assert.equal(read.status, 0, `this checkout's history holds blob ${LISTED}: ${read.failure || read.stderr}`);
  return read.stdout;
}

/** A one-commit repository holding `files`, and its commit. */
function history(t, files) {
  const graph = fixtureCommittedGraph('runner-history-exempt-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) graph.put(path, body);
  return { root: graph.root, commit: graph.commit() };
}

/** A private pack directory removed after the test. */
function packDirectory(t) {
  const files = privateFixtureFiles('runner-history-exempt-pack-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  return files.root;
}

test('runners.exempt.test-1-the-listed-historical-fixture: test 1: the listed historical fixture blob packs although it carries a lease token [C7,#7919]', t => {
  const repo = history(t, { [FIXTURE]: listedBytes() });
  assert.equal(runFixtureGit(['rev-parse', `HEAD:${FIXTURE}`], { cwd: repo.root }).trim(), LISTED, 'the fixture commits the exact listed blob');
  assert.equal(historicalScanExempt(LISTED, 'blob'), true);
  assert.ok(existsSync(historyPack(repo.root, { commit: repo.commit }, [], packDirectory(t))));
});

test('runners.exempt.test-2-any-other-version-of: test 2: any other version of that fixture file with the same token still refuses RUNNER_SECRET [C7,#7919]', t => {
  const repo = history(t, { [FIXTURE]: Buffer.concat([listedBytes(), Buffer.from('\n')]) });
  const directory = packDirectory(t);
  assert.throws(() => historyPack(repo.root, { commit: repo.commit }, [], directory), { code: 'RUNNER_SECRET' });
  assert.equal(existsSync(join(directory, 'source.pack')), false, 'no pack is written for refused history');
});

test('runners.exempt.test-3-the-same-token-value: test 3: the same token value at any other path still refuses RUNNER_SECRET [C7,#7919]', t => {
  // The lease token the listed blob carries, taken from its own bytes.
  const token = /"token":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/u.exec(listedBytes().toString('latin1'))?.[1];
  assert.ok(token, 'the listed blob carries a lease token');
  const repo = history(t, { 'notes/lease.json': `{"holder":{"token":"${token}"}}\n` });
  assert.throws(() => historyPack(repo.root, { commit: repo.commit }, [], packDirectory(t)), { code: 'RUNNER_SECRET' });
  assert.equal(historicalScanExempt(LISTED, 'tree'), false, 'only a blob with a listed id is exempt');
});
