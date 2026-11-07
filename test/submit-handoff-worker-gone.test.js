/** A queued or running hand-off whose worker is gone is requeued by the dispatcher's drain, never shown in the gate for hours [C7,#3221]. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../apps/lib/index.js';
import { recordSubmitHandoff } from '../packages/jobs/index.js';
import { fixture, state } from './submit-handoff-fixture.js';

/** Age the queued or running job's recorded start by `ms`, standing in for time passing on the fixture's own board. */
function ageHandoff(box, id, ms) {
  // @pullboard-board-file journey: age the fixture's own hand-off record, as ten minutes passing would.
  const board = openBoard(box.boardFile);
  try {
    const key = `submit_handoff:${id}`;
    const job = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key).meta_value);
    job.at = new Date(Date.now() - ms).toISOString();
    if (job.startedAt) job.startedAt = job.at;
    board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(job), key);
    // The gate job holds the record submitHandoff() reads, so the aged copy goes there too (#3474).
    recordSubmitHandoff(board.db, id, job);
  } finally { board.db.close(); }
}

/** Count the item's recorded hand-off events that moved a job into `jobState`. */
function handoffEvents(box, id, jobState) {
  // @pullboard-board-file journey: count the events the separate dispatcher sweep wrote to the fixture's own board.
  const board = openBoard(box.boardFile);
  try {
    return board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit-handoff'").all(id)
      .filter(row => JSON.parse(row.event_detail).state === jobState).length;
  } finally { board.db.close(); }
}

/**
 * Run one dispatcher drain on the fixture's repository and return what it printed.
 * Why: the drain's sweep reports a hand-off it could not end on stderr only, so a failed case quotes it.
 */
function drainOnce(box, source) {
  const run = spawnSync(process.execPath, [join(source, 'bin/handoff-worker-dispatcher.js')], { cwd: join(box.repo, '.git'), env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, `the drain exits 0\n${run.stdout}${run.stderr}`);
  return `${run.stdout}${run.stderr}`;
}

test('clause 1: a drain requeues a gone-worker hand-off once as worker-gone, and clause 2: show names the requeue and its reason [C7]', async t => {
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '..');
  const tools = join(box.dir, 'silent-tools');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'apps/lib/src/shell/submit-handoff-worker.js');
  // The CLI imports this module too, so only the launched worker process exits.
  writeFileSync(worker, `if (process.argv[1]?.endsWith('submit-handoff-worker.js')) process.exit(0);\n` + readFileSync(worker, 'utf8'));
  const subOut = execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(JSON.parse(subOut).queued, true);
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  await box.helpers.waitFor(() => existsSync(join(directory, 'worker.json')), 'the dispatcher recording its worker', 120000); // budget: hang ceiling for observed dispatcher progress.
  const owner = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
  await box.helpers.waitFor(() => { // budget: owned process exit ceiling, not a timing assertion.
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 'actual first worker exit', 120000);
  rmSync(join(directory, 'worker.json'));
  const drain = () => drainOnce(box, source);

  ageHandoff(box, box.id, 11 * 60_000);
  const swept = drain();
  const requeued = state(box, box.id);
  assert.notEqual(requeued.job.id, first.id, `clause 1: a successor job carries the same source\n${swept}\n${JSON.stringify(requeued.job)}`);
  assert.equal(requeued.job.retryOf, first.id);
  assert.equal(requeued.job.commit, first.commit);
  assert.equal(requeued.job.requeuedFor, 'worker-gone');
  assert.equal(requeued.item.item_status, 'claimed', 'clause 1: the builder keeps the claim');
  assert.equal(handoffEvents(box, box.id, 'infrastructure'), 1, 'clause 1: one board event records the ended job');
  drain();
  assert.equal(handoffEvents(box, box.id, 'infrastructure'), 1, 'clause 1: a second drain adds no event for the same item');

  const shown = box.run(box.web, 'show', String(box.id));
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /requeued on the same source after worker-gone/u, 'clause 2: show names the requeue and its reason');
  const json = JSON.parse(box.run(box.web, 'show', String(box.id), '--json').out);
  assert.equal(json.queuedSubmit.requeuedFor, 'worker-gone', 'clause 2: show --json carries the reason');
});

test('clause 1: a drain ends a hand-off whose folder no longer exists as infrastructure once, and the builder keeps the claim [C7]', async t => {
  const box = fixture(t);
  const source = resolve(import.meta.dirname, '..');
  const tools = join(box.dir, 'silent-tools');
  cpSync(source, tools, { recursive: true, filter: path => !path.startsWith(join(source, '.git')) });
  const worker = join(tools, 'apps/lib/src/shell/submit-handoff-worker.js');
  writeFileSync(worker, `if (process.argv[1]?.endsWith('submit-handoff-worker.js')) process.exit(0);\n` + readFileSync(worker, 'utf8'));
  const subOut = execFileSync(process.execPath, [join(tools, 'bin/pullboard.js'), 'submit', String(box.id), '--no-next', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(JSON.parse(subOut).queued, true);
  const first = state(box, box.id).job;
  const directory = join(box.repo, '.git', 'pullboard', 'submit-handoffs', first.id);
  await box.helpers.waitFor(() => existsSync(join(directory, 'worker.json')), 'the dispatcher recording its worker', 120000); // budget: hang ceiling for observed dispatcher progress.
  const owner = JSON.parse(readFileSync(join(directory, 'worker.json'), 'utf8'));
  await box.helpers.waitFor(() => { // budget: owned process exit ceiling, not a timing assertion.
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }, 'actual first worker exit', 120000);
  rmSync(directory, { recursive: true, force: true });
  const drain = () => drainOnce(box, source);

  ageHandoff(box, box.id, 11 * 60_000);
  const swept = drain();
  const ended = state(box, box.id);
  assert.notEqual(ended.job.state, 'queued', `clause 1: a ghost queued job is not left in the gate\n${swept}\n${JSON.stringify(ended.job)}`);
  assert.notEqual(ended.job.state, 'running');
  assert.equal(ended.item.item_status, 'claimed', 'clause 1: the builder keeps the claim');
  const ends = () => handoffEvents(box, box.id, ended.job.state);
  assert.equal(ends(), 1, 'clause 1: one board event records the ended job');
  drain();
  assert.equal(ends(), 1, 'clause 1: a second drain adds no event');
});
