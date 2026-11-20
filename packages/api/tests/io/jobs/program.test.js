/** With runs_store on, an offer stores its program text once in the runs file's program table and holds only the hash, and the claimed job reads the same text back [B2,P7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellSandbox } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { RUNS_STORE_KEY } from '../../../../store/index.js';
import { jobView } from '../../../../jobs/index.js';
import { jobRequest } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { queueFor } from '../../../index.js';

const BASE = 'a'.repeat(40);
const ENTRY = `// gate entry\n${'export const step = () => 1;\n'.repeat(40)}`;
const RUN_TEXT = `process.stdout.write(${JSON.stringify('x'.repeat(600))});`;
const REQUEST = { run: ['node', '-e', RUN_TEXT], gate: 'gate:p', input: { main: BASE, entry: ENTRY, data: { main: BASE } } };

/** A file board with runs_store on and its queue. */
function queued(t) {
  const dir = cellSandbox(t).dir;
  const board = cellBoard(t, join(dir, 'board.sqlite'), undefined, { real: true });
  board.seat = cellSeat(board, { lane: 'web', path: join(dir, 'seat') });
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue.runs.db.close());
  return { board, queue, runs: queue.runs.db };
}

/** The offered row's request, as the runs file holds it. */
const offeredRow = (runs, id) => JSON.parse(runs.prepare("SELECT job_step_payload AS text FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered'").get(id).text).request;

test('api.jobs-program.offer-holds-only-the-hash: clause 1: with runs_store on, two offers of one program store its text once in the program table and each offer holds only the hash [B2,P7]', t => {
  const { board, queue, runs } = queued(t);
  offerJob(board.db, { id: 'gate:p1', kind: 'gate', candidate: BASE, base: BASE, now: 1, request: REQUEST }, queue);
  offerJob(board.db, { id: 'gate:p2', kind: 'gate', candidate: BASE, base: BASE, now: 2, request: { ...REQUEST, gate: 'gate:p2' } }, queue);
  const rows = runs.prepare('SELECT program_sha256 AS sha, program_text AS text FROM program ORDER BY program_text').all();
  assert.deepEqual(rows.map(row => row.text).sort(), [ENTRY, RUN_TEXT].sort(), 'each program text is stored once');
  for (const id of ['gate:p1', 'gate:p2']) {
    const request = offeredRow(runs, id);
    assert.deepEqual(Object.keys(request.input.entry), ['$program']);
    assert.match(request.input.entry.$program, /^[0-9a-f]{64}$/u);
    assert.deepEqual(request.run[2], { $program: rows.find(row => row.text === RUN_TEXT).sha });
    assert.ok(!JSON.stringify(jobView(runs, id)).includes('export const step'), 'no step of the job holds the entry text');
  }
});

test('api.jobs-program.claimed-job-reads-the-text: clause 2: a claimed job reads back the same program text it was offered with [B2,P7]', t => {
  const { board, queue, runs } = queued(t);
  offerJob(board.db, { id: 'gate:p1', kind: 'gate', candidate: BASE, base: BASE, now: 1, request: REQUEST }, queue);
  const held = claimJob(runs, { runner: 'r-one', capabilities: [], now: 2 });
  const answer = jobRequest(runs, { job: 'gate:p1', runner: 'r-one', token: held.token });
  assert.deepEqual(answer.request, REQUEST);
});
