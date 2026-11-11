/** Big job results live in a content-addressed blob store, not in board rows [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { openCellBoard } from '../../fixtures/cell.js';
import { closeBoard } from '../../../../../apps/lib/index.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { jobView } from '../../../../jobs/index.js';
import { blobDirOf } from '../../../../jobs/index.js';
import { BLOB_THRESHOLD_BYTES } from '../../../../jobs/index.js';
import { storedResult } from '../../../../drive/src/logic/keyed.js';
import { keyedResult } from '../../../../drive/index.js';
import { exportBoard } from '../../../index.js';
import { migrateJobBlobs } from '../../../index.js';
import { compactBoard } from '../../../index.js';

/** A result body of about `kilobytes` KB, different for every seed. */
function body(seed, kilobytes) {
  return { tree: seed, files: Array.from({ length: kilobytes }, (_, index) => `${seed}/${index}`.padEnd(1000, 'x')) };
}

/** A board on a real file with the job tables a writable open installs. */
function boardOf(t) {
  const board = cellBoard(t, cellProject(t).boardFile);
  return { board, db: board.db, dir: blobDirOf(board.db) };
}

test('clause 1: a result over 64 KB is one blob file and the row keeps its hash and size; reading returns the same bytes [C7]', (t) => {
  const { db, dir } = boardOf(t);
  createJob(db, { id: 'cells-inventory:t1', kind: 'cells-inventory', candidate: 't1' });
  const big = { result: body('t1', 80), owner: 'a' };
  const text = JSON.stringify(big);
  assert.ok(text.length > BLOB_THRESHOLD_BYTES);
  const written = writeStep(db, 'cells-inventory:t1', 'result', big);
  assert.deepEqual(written.payload, big);
  const hash = createHash('sha256').update(text).digest('hex');
  const row = db.prepare('SELECT job_step_payload AS p FROM job_step').get();
  assert.deepEqual(JSON.parse(row.p), { blob: hash, size: Buffer.byteLength(text) });
  assert.equal(readFileSync(join(dir, hash), 'utf8'), text);
  assert.equal(statSync(join(dir, hash)).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o077, 0, 'the blob directory is private');
  assert.deepEqual(jobView(db, 'cells-inventory:t1').steps[0].payload, big);
  assert.deepEqual(storedResult(jobView(db, 'cells-inventory:t1')).result, big.result);
  assert.deepEqual(writeStep(db, 'cells-inventory:t1', 'result', { other: 1 }), { written: false, payload: big });
});

test('clause 1: identical results share one blob, small payloads stay in the row and no temp file is left [C7]', (t) => {
  const { db, dir } = boardOf(t);
  for (const id of ['cells-inventory:a', 'cells-inventory:b']) {
    createJob(db, { id, kind: 'cells-inventory', candidate: id });
    writeStep(db, id, 'result', { result: body('same', 70) });
  }
  createJob(db, { id: 'gate:1', kind: 'gate-drive', candidate: '1' });
  writeStep(db, 'gate:1', 'collected', { small: 'yes' });
  assert.equal(readdirSync(dir).length, 1);
  const rows = db.prepare('SELECT job_step_payload AS p FROM job_step ORDER BY job_step_id').all();
  assert.equal(rows[0].p, rows[1].p);
  assert.equal(rows[2].p, '{"small":"yes"}');
});

test('clause 1: a gate hand-off record stays in the row whatever its size [C7]', (t) => {
  const { db, dir } = boardOf(t);
  createJob(db, { id: 'gate:2', kind: 'gate', item: null, candidate: '2' });
  const payload = { agent: 'a', record: { id: 'gate:2', state: 'red', error: { message: 'x'.repeat(90_000) } } };
  writeStep(db, 'gate:2', 'red', payload);
  assert.ok(db.prepare('SELECT length(job_step_payload) AS n FROM job_step').get().n > BLOB_THRESHOLD_BYTES);
  assert.equal(existsSync(dir), false);
  assert.deepEqual(jobView(db, 'gate:2').steps[0].payload, payload);
});

test('clause 2: the upgrade moves oversized payloads, keeps only the newest cells-inventory body and compacts the file [C7]', (t) => {
  const project = cellProject(t);
  let board = openCellBoard(project.boardFile);
  const bodies = ['t1', 't2', 't3'].map(tree => ({ result: body(tree, 600), owner: 'a' }));
  for (const [index, payload] of bodies.entries()) {
    createJob(board.db, { id: `cells-inventory:t${index + 1}`, kind: 'cells-inventory', candidate: `t${index + 1}` });
    board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, 0, ?, ?)')
      .run(`cells-inventory:t${index + 1}`, 'result', JSON.stringify(payload), index);
  }
  createJob(board.db, { id: 'gate-drive:x', kind: 'gate-drive', candidate: 'x' });
  const collected = { sections: body('c', 100) };
  board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, 0, ?, 0)')
    .run('gate-drive:x', 'collected', JSON.stringify(collected));
  const file = project.boardFile;
  board.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = statSync(file).size;
  assert.ok(before > 1_800_000);
  closeBoard(board);

  board = openCellBoard(file);
  t.after(() => { try { closeBoard(board); } catch { /* closed below */ } });
  const dir = blobDirOf(board.db);
  assert.equal(readdirSync(dir).length, 2, 'the newest inventory and the other big result are blobs; old copies keep no body');
  const old = jobView(board.db, 'cells-inventory:t1');
  assert.equal(old.steps[0].payload.pruned, true);
  assert.equal(storedResult(old), undefined);
  assert.deepEqual(jobView(board.db, 'cells-inventory:t3').steps[0].payload, bodies[2]);
  assert.deepEqual(jobView(board.db, 'gate-drive:x').steps[0].payload, collected);
  assert.equal(compactBoard(board.db).compacted, false, 'a small board is not worth a rewrite');
  assert.equal(compactBoard(board.db, { minFreeBytes: 1 }).compacted, true);
  assert.ok(statSync(file).size < before / 2, `${statSync(file).size} bytes after, ${before} before`);
  assert.deepEqual(migrateJobBlobs(board.db), { moved: 0, pruned: 0, bytes: 0 }, 'a second run finds nothing to do');
  assert.ok(board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key = 'job_blobs:1'").get(), 'the move leaves its mark');
});

test('clause 2: a pruned inventory is produced again and the new result replaces the stub [C7]', async (t) => {
  const { db } = boardOf(t);
  createJob(db, { id: 'cells-inventory:old', kind: 'cells-inventory', candidate: 'old' });
  const hash = createHash('sha256').update('gone').digest('hex');
  db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES ('cells-inventory:old', 'result', 0, ?, 0)")
    .run(JSON.stringify({ blob: hash, size: 4 }));
  const produced = await keyedResult(db, { kind: 'cells-inventory', key: 'old', owner: 'w', produce: async () => ({ fresh: true }) });
  assert.equal(produced.state, 'produced');
  assert.deepEqual(produced.result, { fresh: true });
  assert.deepEqual(storedResult(jobView(db, 'cells-inventory:old')).result, { fresh: true });
});

test('clause 2: a board with nothing to move takes no mark, so it stays importable [C7]', (t) => {
  const { db } = boardOf(t);
  assert.deepEqual(migrateJobBlobs(db), { moved: 0, pruned: 0, bytes: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key = 'job_blobs:1'").get().n, 0);
});

test('clause 2: compaction waits for room and for the write lock, and changes nothing otherwise [C7]', (t) => {
  const { db } = boardOf(t);
  assert.deepEqual(compactBoard(db, { minFreeBytes: 1e12 }), { compacted: false, reason: 'little free space' });
});

test('clause 3: an export carries the payload a blob stands for and leaves the local move mark out [C7]', (t) => {
  const { board, db } = boardOf(t);
  createJob(db, { id: 'cells-inventory:e', kind: 'cells-inventory', candidate: 'e' });
  const payload = { result: body('e', 90), owner: 'a' };
  writeStep(db, 'cells-inventory:e', 'result', payload);
  assert.ok(db.prepare('SELECT length(job_step_payload) AS n FROM job_step').get().n < 200);
  const document = exportBoard(board);
  assert.deepEqual(JSON.parse(document.tables.job_step[0].job_step_payload), payload);
  assert.equal(document.tables.board_meta.some(row => row.meta_key === 'job_blobs:1'), false);
});
