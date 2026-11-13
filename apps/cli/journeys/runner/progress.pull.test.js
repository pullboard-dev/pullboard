/** A pulled job reports per-file test progress: runner serve posts the run's progress reporter lines as the job's progress step [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { offerJob } from '../../../../packages/api/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';
import { sideReporters } from '../../../../packages/gate/src/io/test/progress.js';

/** The progress reporter run-tests adds when a runner names a progress file. */
const REPORTER = sideReporters({}, { PULLBOARD_TEST_PROGRESS: devNull })[0].reporter;
const FILES = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js'];

/** A local board serving its job queue under pull, and a trunk remote holding a candidate with three test files; b fails. */
async function progressBoard(t) {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: box.env, encoding: 'utf8' }).trim();
  const trunk = join(box.dir, 'trunk.git'), source = join(box.dir, 'source');
  git(box.dir, 'clone', '-q', '--bare', box.root, trunk);
  git(box.dir, 'clone', '-q', trunk, source);
  mkdirSync(join(source, 'tests'), { recursive: true });
  for (const file of FILES) {
    const red = file.includes('/b.');
    writeFileSync(join(source, file), `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n`
      + `test('${file}', async () => { await new Promise(done => setTimeout(done, 400)); assert.equal(${red ? 1 : 0}, 0); });\n`);
  }
  git(source, 'add', 'tests');
  git(source, 'commit', '-q', '-m', 'candidate');
  git(source, 'push', '-q', trunk, 'HEAD:refs/heads/candidate');
  const settings = join(box.root, 'pullboard.json');
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), trunk: { remote: trunk } }, null, 2));
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  return { commit: git(source, 'rev-parse', 'HEAD'), db, board: `${box.origin}${box.path}?k=${box.key}`, cache: join(box.dir, 'runner-cache') };
}

/** The job's latest progress row on the board, as the live reader (#5804) selects it. */
function boardProgress(db, job) {
  const row = db.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'progress' ORDER BY job_step_seq DESC, job_step_id DESC LIMIT 1").get(job);
  return row ? JSON.parse(row.job_step_payload) : null;
}

test('clause 1: while a pulled job runs, the board records progress steps whose done count rises as test files finish, with each file\'s state [P7]', { timeout: 90_000 }, // budget: hang ceiling for a private init, API start, a git fetch and three 0.4 s test files.
async (t) => {
  const { commit, db, board, cache } = await progressBoard(t);
  // The job's own test runner must run as a top-level run, as on a real runner, not as a child of this test's runner.
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; });
  // The job runs Node's test runner with Pullboard's progress reporter, one file at a time, as the gate's proof does.
  offerJob(db, { id: 'test:progress', kind: 'test', needs: ['node22'], candidate: commit,
    run: [process.execPath, '--test', '--test-concurrency=1', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${devNull}`, ...FILES] });
  const seen = [];
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    const body = JSON.parse(init.body);
    if (body.action === 'progress') {
      assert.equal(response.status, 200, 'the holder\'s progress post is accepted');
      seen.push({ posted: body.progress, recorded: boardProgress(db, 'test:progress'), step: jobView(db, 'test:progress').step });
    }
    return response;
  };
  const served = await serveRunner({ board, runner: 'r-progress', capabilities: ['node22'], cache, once: true, fetchImpl, timing: { idleMs: 10, progressMs: 50 } });
  assert.deepEqual(served.jobs.map(job => [job.job, job.outcome]), [['test:progress', 'posted']]);

  assert.ok(seen.length >= 2, `progress was posted while the job ran (${seen.length} posts)`);
  for (const { posted, recorded, step } of seen) {
    assert.deepEqual(recorded, posted, 'each post is what the board records as the latest progress step');
    assert.notEqual(step, 'done', 'progress arrives before the receipt');
  }
  const done = seen.map(entry => entry.recorded.finished);
  assert.ok(done.every((count, index) => index === 0 || count >= done[index - 1]), `done never falls: ${done}`);
  assert.ok(new Set(done).size >= 2, `done rises as files finish: ${done}`);
  assert.ok(seen.some(entry => Object.values(entry.recorded.files).includes('running')), 'a file reads running while it runs');
  const last = boardProgress(db, 'test:progress');
  assert.deepEqual([last.finished, last.failures], [3, 1]);
  assert.deepEqual(last.files, { 'tests/a.test.js': 'green', 'tests/b.test.js': 'red', 'tests/c.test.js': 'green' }, 'each file\'s state by repository-relative path');
  assert.deepEqual(last.latest, ['tests/c.test.js', 'tests/b.test.js', 'tests/a.test.js'], 'finished files newest first');
  assert.doesNotMatch(JSON.stringify(last), new RegExp(`${cache.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}|r-progress`, 'u'), 'no checkout path or runner name in the step');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = 'test:progress' AND job_step_name = 'progress'").get().n, 1, 'one progress row per attempt, replaced by each post');
  assert.equal(jobView(db, 'test:progress').step, 'done', 'the receipt still closes the job');
});

test('clause 1: run-tests adds the progress reporter only when the runner names a progress file [P7]', () => {
  const reporters = env => sideReporters({}, env).map(entry => entry.reporter);
  assert.deepEqual(reporters({}), []);
  assert.match(reporters({ PULLBOARD_TEST_PROGRESS: devNull })[0], /packages\/gate\/src\/io\/test\/progress\.js$/u);
});
