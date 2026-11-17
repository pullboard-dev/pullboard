/** A pulled runner hands a land handler the proof the job kept in its request, so a large proof never rides the payload [C7,#7766]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { serveRunner } from '../../../../drive/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { jobQueueCall } from '../../../index.js';
import { offerLandingJob } from '../../../index.js';
import { recordTestResults } from '../../../../store/index.js';

// The land handler is stubbed, so the runner's git is never asked for anything.
const pullGit = async () => ({ status: 0, stdout: '', stderr: '' });
const COMMIT = 'a'.repeat(40);
const PROVED_FILES = 700; // large enough that the proof could not ride a payload

test('clause 2: the runner serving a land job whose proof moved to its request gives the handler the whole proof [C7,#7766]', async t => {
  const db = cellBoard(t, ':memory:').db;
  const rows = Array.from({ length: PROVED_FILES }, (_, index) => ({ file: `packages/area/tests/io/some/deeper/case-${index}.test.js`, inputKey: index.toString(16).padStart(64, '0'),
    command: 'proof', context: 'c'.repeat(64), status: 'pass' }));
  recordTestResults(db, { receipt: 'gate:big#0', origin: 'pulled:r-gate', commit: COMMIT, rows });
  offerLandingJob(db, { items: [{ id: 7752, commit: COMMIT, ref: 'refs/pullboard/land/7752' }], expect: 'b'.repeat(40), config: { trunk: { remote: '/trunk.git' }, affectedTests: 'node bin/proof.mjs' } });
  const fetchImpl = async (_url, { body }) => ({ status: 200, json: async () => jobQueueCall(db, JSON.parse(body), { mode: 'pull' }) });
  const { root } = privateFixtureFiles('pullboard-requested-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const handlers = { land: async claim => { seen.push(claim.payload); return { outcome: 'red', detail: 'stop here' }; } };
  await serveRunner({ git: pullGit, board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'r-land', capabilities: [], cache: root, once: true, fetchImpl, handlers, trunkPack: async () => {} });
  assert.equal(seen.length, 1, 'the handler ran once');
  assert.equal(seen[0].proof.files.length, PROVED_FILES, 'the handler holds every proved file');
  assert.equal(seen[0].proof.runner, 'node bin/proof.mjs');
  assert.deepEqual(seen[0].items.map(entry => entry.id), [7752]);
});
