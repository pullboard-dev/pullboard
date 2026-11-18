/** With runs_store on, pullboard test queues, reads and cancels a run through the runs file; off, the board holds the rows as on main [P7,#9111]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { MACHINE_CONTEXT_ENV } from '../../../../../packages/drive/index.js';
import { readTestRun } from '../../../../../packages/drive/index.js';
import { RUNS_STORE_KEY } from '../../../../../packages/store/index.js';
import { boardRunsHolder } from '../../../../../packages/store/index.js';
import { runsFilePath } from '../../../../../packages/store/index.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fileFixtureItem } from '../../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The board file of a fixture project. */
const boardFileOf = box => join(box.repo, '.git', 'pullboard', 'board.sqlite');

const TEST_FILE = 'web/runs.test.js';

/** A box whose web seat holds a claim and can queue a run; the runs_store flag is set as asked. */
function seatBox(flag) {
  const box = e2e.project();
  // A queued run's worker is a long sleep, so it is still running when the case reads and cancels it.
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.web, { config: { ...config, affectedTests: 'node -e "setTimeout(() => {}, 60000)"' } });
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, TEST_FILE), "import { test } from 'node:test';\ntest('runs [G1]', () => {});\n");
  // A pulled run tests committed source only, so the seat's setup is committed before it queues.
  box.git(box.web, 'add', '-A');
  box.git(box.web, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'test: runs fixture');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Runs store wiring', args: ['--specs', 'G1'] });
  assert.equal(box.runSync(box.web, 'claim', String(item.item_id)).code, 0);
  if (flag) withFixtureBoard(boardFileOf(box), board => board.db.prepare('INSERT OR REPLACE INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1'));
  // A seat at its own prompt: no machine variable, no outer CLI.
  for (const key of [...MACHINE_CONTEXT_ENV, 'PULLBOARD_TEST_RUNNER_PID']) delete box.env[key];
  // The case cancels its own run, so the fixture must not wait for the queued run to settle (a board-held run kept the queue call for the whole 60 s sleep).
  box.env.PULLBOARD_FIXTURE_UNSETTLED = '1';
  return box;
}

/** The id the queue line printed. */
function queuedId(out) {
  const id = /queued test run ([0-9a-f-]{36})/u.exec(out)?.[1];
  assert.ok(id, out);
  return id;
}

/** A cancel found the run: it cancelled it, or refused because the fast worker had already finished it; an unknown run is NO_TEST_RUN. */
function assertFound(cancelled, id) {
  if (cancelled.code === 0) return assert.match(cancelled.out, new RegExp(`cancelled test run ${id}`, 'u'));
  assert.match(cancelled.err, /\[TEST_RUN_FINISHED\]/u, `${cancelled.out}${cancelled.err}`);
}

test('cli.io-commands-test-runs-store.with-runs-store-on-test-queues-reads: clause 1: with runs_store on, test queues, reads and cancels a run through the runs file [P7,#9111]', async () => {
  const box = seatBox(true);
  const queued = await box.inProcess(box.web, 'test', TEST_FILE);
  assert.equal(queued.code, 0, `${queued.out}${queued.err}`);
  const id = queuedId(queued.out);
  const where = withFixtureBoard(boardFileOf(box), board => ({
    board: board.db.prepare('SELECT COUNT(*) AS n FROM job WHERE job_id = ?').get(id).n,
    runs: boardRunsHolder(board, boardFileOf(box)).db.prepare('SELECT COUNT(*) AS n FROM job WHERE job_id = ?').get(id).n,
  }));
  assert.deepEqual(where, { board: 0, runs: 1 }, 'the run lives in the runs file and not on the board');
  const status = await box.inProcess(box.web, 'test', '--status', id);
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  assert.match(status.out, new RegExp(`test run ${id} `, 'u'));
  const cancelled = await box.inProcess(box.web, 'test', '--cancel', id);
  assertFound(cancelled, id);
  const after = await box.inProcess(box.web, 'test', '--status', id);
  assert.match(after.out, new RegExp(`test run ${id}`, 'u'), 'the run is still read through the runs file');
});

test('cli.io-commands-test-runs-store.with-runs-store-off-the-board-holds: clause 2: with runs_store off, the board holds the run rows and no runs file is made [P7,#9111]', async () => {
  const box = seatBox(false);
  const queued = await box.inProcess(box.web, 'test', TEST_FILE);
  assert.equal(queued.code, 0, `${queued.out}${queued.err}`);
  const id = queuedId(queued.out);
  const found = withFixtureBoard(boardFileOf(box), board => ({ run: readTestRun(board, id).id, runsFile: existsSync(runsFilePath(boardFileOf(box))) }));
  assert.deepEqual(found, { run: id, runsFile: false }, 'the board reads the run and the runs file is never opened');
  const status = await box.inProcess(box.web, 'test', '--status', id);
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  const cancelled = await box.inProcess(box.web, 'test', '--cancel', id);
  assertFound(cancelled, id);
});
