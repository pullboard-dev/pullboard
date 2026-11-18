/** The live snapshot reads a real board, the machine's runner leases and the landing worker's records into anonymous runner progress [C7,N26]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../../../packages/store/tests/fixtures/cell.js';
import * as store from '../../../../../packages/store/index.js';
import { claimJob } from '../../../../../packages/api/index.js';
import { offerJob } from '../../../../../packages/api/index.js';
import { writeStep } from '../../../../../packages/jobs/index.js';
import { closeResourceConnections } from '../../../../../packages/resources/index.js';
import { listResources } from '../../../../../packages/resources/index.js';
import { landingGateRuns } from '../../../src/io/live/read.js';
import { publicLiveRunners } from '../../../src/io/live/read.js';
import { readLiveRunners } from '../../../src/io/live/read.js';
import { runsJobs } from '../../../src/io/serve.js';
import { repoInfo } from '../../../../../packages/git/index.js';

const MINUTE = 60_000;
const BATCH = '0f6a2b7e-1111-4222-8333-944455556666';
const FILES = ['apps/a.test.js', 'apps/b.test.js', 'apps/c.test.js'];

/** A real repository and board with a gating landing, a pulled test job and two runner leases on a private machine home. */
function liveFixture(t) {
  const saved = { home: process.env.PULLBOARD_HOME, machine: process.env.PULLBOARD_MACHINE_HOME };
  const homes = cellSandbox(t).dir;
  process.env.PULLBOARD_HOME = join(homes, 'home');
  process.env.PULLBOARD_MACHINE_HOME = join(homes, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  t.after(() => {
    closeResourceConnections();
    for (const [name, value] of [['PULLBOARD_HOME', saved.home], ['PULLBOARD_MACHINE_HOME', saved.machine]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const repo = cellRepo(t);
  const gatingAt = Date.now() - 20 * MINUTE;
  const board = cellBoard(t, repo.boardFile, { now: () => new Date(gatingAt) });
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  store.recordLandingBatch(board, { agentId: 'coordinator', revision: 0, batch: { version: 1, id: BATCH, state: 'gating', pid: 4242,
    base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/fixture', branch: 'refs/heads/main', owner: 'pid-4242', logPath: '/fixture/log',
    items: [{ id: 1196, commit: 'c'.repeat(40) }], candidates: [], conflicts: [] } });
  // The pulled job: a test run naming two files, claimed by a runner that reports one finished file with one failure.
  const offeredAt = Date.now() - 4 * MINUTE;
  offerJob(board.db, { id: 'test:5774', kind: 'test', needs: ['node22'], item: 5774, candidate: 'd'.repeat(40), base: 'a'.repeat(40),
    request: { run: ['node', 'run.js'], input: { data: { files: FILES.slice(0, 2) } } }, now: offeredAt });
  const claim = claimJob(board.db, { runner: 'aux-9', capabilities: ['node22'], now: offeredAt + MINUTE, leaseMs: 30 * MINUTE });
  writeStep(board.db, claim.job, 'progress', { finished: 1, failures: 1 }, { seq: 1, now: offeredAt + 2 * MINUTE });
  const common = join(repo.root, '.git');
  const selectedAt = new Date(gatingAt + 1000).toISOString();
  mkdirSync(join(common, 'pullboard', 'automatic-landing'), { recursive: true });
  writeFileSync(join(common, 'pullboard', 'automatic-landing', 'worker.log'), [
    `${new Date(gatingAt - 3 * 3_600_000).toISOString()} gate candidate: 9 files selected; running`,
    `${new Date(gatingAt - 3 * 3_600_000 + MINUTE).toISOString()} gate candidate: run finished green`,
    `${selectedAt} gate candidate: reused #1196's submit receipt; rerunning 3 file(s) whose import closure changed since the submit: ${FILES.join(', ')}`,
    `${selectedAt} gate candidate: 3 files selected; running`, '(node:1) ExperimentalWarning: SQLite is an experimental feature', ''].join('\n'));
  writeFileSync(join(common, 'pullboard', 'landing-file-times.json'), JSON.stringify({ version: 1, files: { [FILES[0]]: 10 * MINUTE, [FILES[1]]: 30 * MINUTE, [FILES[2]]: 20 * MINUTE } }));
  // The controller-pushed runs: a landing shard and a seat's test on the machine's real runner lease table.
  listResources({ scope: 'machine' });
  const resources = join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite');
  const leases = new DatabaseSync(resources);
  const lease = leases.prepare('INSERT INTO holder (token, name, pid, agent, repo, since, heartbeat, landing, item, kind, runner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  lease.run('shard-1', 'runner:mini-1', process.pid, 'coordinator', `${common}/pullboard/landings/${BATCH}/candidates/x/worktree`, new Date(gatingAt).toISOString(), Date.now(), 1, '', 'landing', 'mini-1');
  lease.run('seat-1', 'runner:mini-2', process.pid, 'core-7', '/seat', new Date(Date.now() - 3 * MINUTE).toISOString(), Date.now(), 0, '41', 'test', 'mini-2');
  leases.close();
  return { repo, common, resources, claimedAt: offeredAt + MINUTE };
}

test('view.x-io-live-read.a-landing-log-names-each-gate-it: a landing log names each gate it opened, its selected files and whether it finished [C7,N26]', () => {
  const runs = landingGateRuns([
    "2026-11-11T19:00:00.000Z gate candidate: reused #1's submit receipt; rerunning 2 file(s) whose import closure changed since the submit: a.test.js, b.test.js",
    '2026-11-11T19:00:01.000Z gate candidate: 2 files selected; running',
    '2026-11-11T19:05:00.000Z gate candidate: run finished red',
    '2026-11-11T19:06:00.000Z gate trunk-moved-1: the full plan selected; running',
  ].join('\n'));
  assert.deepEqual(runs.map(run => [run.label, run.selected, run.files, run.finished]),
    [['candidate', 2, ['a.test.js', 'b.test.js'], true], ['trunk-moved-1', null, null, false]]);
});

test('view.x-io-live-read.the-live-snapshot-reads-every-runner-and: the live snapshot reads every runner and each running gate or landing from the real board and leases [C7,N26]', t => {
  const { common, resources, claimedAt } = liveFixture(t);
  const sources = readLiveRunners({ roots: [{ commonDir: common }], now: Date.now(), resources, configured: [{ host: 'mini-3' }], openBoardReadOnly: store.openBoardReadOnly });
  assert.deepEqual(sources.runners.map(runner => [runner.host, runner.holders.length]), [['mini-3', 0], ['mini-1', 1], ['mini-2', 1], ['aux-9', 0]],
    'every configured runner, idle or not, every runner holding a lease and every runner that ran a job');
  assert.deepEqual(sources.jobs.map(job => [job.kind, job.item, job.runner, job.files, job.progress]), [['test', 5774, 'aux-9', FILES.slice(0, 2), { finished: 1, failures: 1 }]]);
  assert.equal(sources.jobs[0].claimedAt, claimedAt, 'a pulled job runs since its current claim step');
  assert.deepEqual(sources.landings.map(landing => [landing.batch, landing.items, landing.label, landing.selected, landing.files]), [[BATCH, [1196], 'candidate', 3, FILES]],
    'the gating record, matched to the gate its worker opened after it and not an older finished one');
  assert.equal(sources.fileTimes[FILES[1]], 30 * MINUTE);
});

test('view.x-io-live-read.publicliverunners-numbers-the-machine-runners-and-carries: publicLiveRunners numbers the machine runners and carries counts and estimates with no runner, seat or path in it [C7,N26]', t => {
  const { repo, common, resources } = liveFixture(t);
  assert.equal(repoInfo(repo.root).commonDir, common);
  const live = publicLiveRunners(common, { resources, configured: [{ host: 'mini-3' }], openBoardReadOnly: store.openBoardReadOnly });
  assert.deepEqual(live.runners.map(runner => [runner.runner, runner.state, runner.jobs.map(job => [job.kind, job.item])]),
    [[1, 'idle', []], [2, 'busy', [['test run', 5774]]], [3, 'busy', [['landing', 1196]]], [4, 'busy', [['test run', 41]]]],
    'configured mini-3 first, then aux-9, mini-1 and mini-2 by name');
  const landing = live.runs.find(run => run.kind === 'landing');
  // 10 + 30 + 20 min recorded over the one shard on runner 3, 20 min in: about 40 min left.
  assert.deepEqual([landing.selected, landing.done, landing.failing, landing.runners, landing.files.map(entry => entry.file)], [3, null, null, [3], FILES]);
  assert.ok(landing.minutesLeft >= 39 && landing.minutesLeft <= 41, `about 40 min left, got ${landing.minutesLeft}`);
  const test = live.runs.find(run => run.item === 5774);
  assert.deepEqual([test.selected, test.done, test.failing, test.runners], [2, 1, 1, [2]]);
  const text = JSON.stringify(live);
  for (const secret of ['mini-', 'aux-9', 'core-7', 'coordinator', '/seat', BATCH, 'test:5774', common]) assert.equal(text.includes(secret), false, `leaks ${secret}`);
});

test('view.x-io-live-read.pull-dispatch-leases-on-the-board-number: pull-dispatch leases on the board number one runner once per runner, shards and main tests included [N26]', t => {
  const { repo, common, resources } = liveFixture(t);
  const board = cellBoard(t, repo.boardFile, { now: () => new Date() });
  const at = Date.now() - 2 * MINUTE;
  for (const [id, kind, runner] of [['gate:7:aa:s1', 'gate-shard', 'pool-51-mill-2cbb55'], ['gate:7:aa:s2', 'gate-shard', 'pool-51-mill-2d74dc'], ['main:1', 'main-test', 'pool-52-lathe-045338']]) {
    offerJob(board.db, { id, kind, needs: ['node22'], item: kind === 'gate-shard' ? 7 : null, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: at });
    claimJob(board.db, { runner, capabilities: ['node22'], now: at + 1000, leaseMs: 30 * MINUTE });
  }
  const live = publicLiveRunners(common, { resources, configured: [], openBoardReadOnly: store.openBoardReadOnly });
  const pulled = live.runners.filter(runner => runner.jobs.some(job => ['gate', 'test run'].includes(job.kind) && [7, null].includes(job.item)));
  assert.deepEqual(pulled.map(runner => runner.jobs.map(job => job.kind)), [['gate', 'gate'], ['test run']], 'the two shards of one restarted runner sit on one numbered entry');
  assert.equal(JSON.stringify(live).includes('mill'), false, 'no runner name leaves the machine');
});

test('view.x-io-live-read.registeredonly-lists-the-configured-runners-carries-each: registeredOnly lists the configured runners, carries each fresh heartbeat as load and folds a pull runner into its host (#8060) [C7]', t => {
  const { repo, common, resources } = liveFixture(t);
  const board = cellBoard(t, repo.boardFile, { now: () => new Date() });
  const at = Date.now() - 2 * MINUTE;
  offerJob(board.db, { id: 'gate:9:aa:s1', kind: 'gate-shard', needs: ['node22'], item: 9, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: at });
  claimJob(board.db, { runner: 'pool-51-mill-2cbb55', capabilities: ['node22'], now: at + 1000, leaseMs: 30 * MINUTE });
  const configured = [{ host: 'me@203.0.113.51', cpuLoad: { at: new Date().toISOString(), busyPercent: 42, average: [1, 1, 1] } },
    { host: 'me@203.0.113.52', cpuLoad: { at: new Date(Date.now() - 3_600_000).toISOString(), busyPercent: 90, average: [1, 1, 1] } }, { host: 'me@203.0.113.53' }];
  const live = publicLiveRunners(common, { resources, configured, openBoardReadOnly: store.openBoardReadOnly, registeredOnly: true });
  assert.deepEqual(live.runners.map(runner => [runner.runner, runner.cpu, runner.jobs.length]), [[1, 42, 1], [2, null, 0], [3, null, 0]],
    'three registered runners; a stale or missing heartbeat has no load; the pull runner works on its host');
});

test('view.x-io-live-read.clause-1-with-runs-store-on-the: clause 1: with runs_store on, the live read takes pulled jobs from a read-only runs handle and finished counts from board run rows [B2,#9016]', t => {
  const { repo, common } = liveFixture(t);
  const board = cellBoard(t, repo.boardFile, { now: () => new Date() });
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get().meta_value;
  const runs = store.openRunsStore(store.runsFilePath(repo.boardFile), { boardId });
  t.after(() => runs.close());
  const at = Date.now() - 2 * MINUTE;
  offerJob(runs, { id: 'gate:77:aa', kind: 'gate', needs: ['node22'], item: 77, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: at });
  claimJob(runs, { runner: 'runs-only-runner', capabilities: ['node22'], now: at + 1000, leaseMs: 30 * MINUTE });
  board.db.prepare("INSERT OR REPLACE INTO board_meta(meta_key, meta_value) VALUES ('runs_store', '1')").run();
  const now = Date.now();
  board.db.prepare("INSERT INTO run (run_job, run_kind, run_item, run_state, run_created, run_updated) VALUES ('gate:5:aa', 'gate', 5, 'done', ?, ?)").run(now - MINUTE, now - MINUTE);
  const sources = readLiveRunners({ roots: [{ commonDir: common }], now, resources: join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), openBoardReadOnly: store.openBoardReadOnly, jobsFor: runsJobs });
  assert.deepEqual(sources.jobs.map(job => [job.kind, job.item, job.runner]), [['gate', 77, 'runs-only-runner']], 'the board job table holds the test job; only the runs file jobs show when on');
  assert.ok(sources.runners.some(runner => runner.host === 'runs-only-runner'), 'the runner that ran a runs-file job shows');
});

test('view.x-io-live-read.clause-2-with-runs-store-off-the: clause 2: with runs_store off, the live read returns the same job rows as before, from the board [B2,#9016]', t => {
  const { repo, common } = liveFixture(t);
  const board = cellBoard(t, repo.boardFile, { now: () => new Date() });
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get().meta_value;
  const runs = store.openRunsStore(store.runsFilePath(repo.boardFile), { boardId });
  t.after(() => runs.close());
  offerJob(runs, { id: 'gate:78:aa', kind: 'gate', needs: ['node22'], item: 78, candidate: 'd'.repeat(40), base: 'a'.repeat(40), request: { run: ['node', 'run.js'] }, now: Date.now() - MINUTE });
  claimJob(runs, { runner: 'runs-only-runner', capabilities: ['node22'], now: Date.now(), leaseMs: 30 * MINUTE });
  const sources = readLiveRunners({ roots: [{ commonDir: common }], now: Date.now(), resources: join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), openBoardReadOnly: store.openBoardReadOnly, jobsFor: runsJobs });
  assert.deepEqual(sources.jobs.map(job => [job.kind, job.item, job.runner]), [['test', 5774, 'aux-9']], 'the flag is off: the runs file is not read');
});
