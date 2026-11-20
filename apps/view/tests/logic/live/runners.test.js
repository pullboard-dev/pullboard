/** The public live snapshot carries anonymous runner progress: numbered runners, kinds, counts, per-file state and time left [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateLeft } from '../../../src/logic/live/runners.js';
import { loadPercents } from '../../../src/logic/live/runners.js';
import { publicRunners } from '../../../src/logic/live/runners.js';
import { publicSnapshot } from '../../../src/logic/public.js';

const MINUTE = 60_000;
const now = Date.parse('2026-11-11T19:00:00.000Z');
const ago = minutes => new Date(now - minutes * MINUTE).toISOString();
const BATCH = '0f6a2b7e-1111-4222-8333-944455556666';
/** Real-looking private names that must never leave the machine. */
const SECRETS = ['runner-a.example.test', '192.0.2.98', 'user', 'core-1898', 'pool-53-runner-8b9e36', '/home/user/Code/pullboard', 'gate:52:abc:x', BATCH, 'view-336'];

/** Raw runner records as readLiveRunners returns them: two pushed runners on a landing and a test, one idle, one pulling a gate. */
function sources({ job = {} } = {}) {
  return {
    now,
    configured: [{ host: 'runner-a.example.test' }, { host: '192.0.2.98' }, { host: 'user@mini' }],
    runners: [
      { host: 'runner-a.example.test', holders: [
        { agent: 'coordinator', repo: `/home/user/Code/pullboard/.git/pullboard/landings/${BATCH}/candidates/abc/worktree`, since: ago(30), item: '', kind: 'landing', landing: 1 },
        { agent: 'core-1898', repo: '/home/user/Code/pullboard/.claude/worktrees/seat', since: ago(3), item: '41', kind: 'test', landing: 0 },
      ] },
      { host: '192.0.2.98', holders: [{ agent: 'view-336', repo: `/home/user/landings/${BATCH}/x/`, since: ago(30), item: '', kind: 'landing', landing: 1 }] },
      { host: 'user@mini', holders: [] },
    ],
    jobs: [{ id: 'gate:52:abc:x', kind: 'gate', item: 52, runner: 'pool-53-runner-8b9e36', claimedAt: now - 2 * MINUTE,
      files: ['apps/a.test.js', 'apps/b.test.js', 'apps/c.test.js', '/home/user/Code/pullboard/private.test.js'], progress: null, ...job }],
    landings: [{ batch: BATCH, items: [1196, 1197], startedAt: now - 30 * MINUTE, label: 'candidate', files: null, selected: 4, progress: null }],
    fileTimes: { 'apps/a.test.js': 2 * MINUTE, 'apps/b.test.js': 4 * MINUTE, 'apps/c.test.js': 6 * MINUTE },
  };
}

test('view.live-runners.clause-1-publicsnapshot-lists-runners-1-n: clause 1: publicSnapshot lists runners 1..N with busy or idle and, for busy ones, kind, item, files selected, done, failing and minutes left, null when unknown [N26]', () => {
  const { live } = publicSnapshot({ live: sources() });
  assert.deepEqual(live.runners.map(runner => [runner.runner, runner.state]), [[1, 'busy'], [2, 'busy'], [3, 'idle'], [4, 'busy']],
    'configured runners in settings order, then other runners by sorted name; numbers only');
  for (const runner of live.runners) assert.deepEqual(Object.keys(runner), ['runner', 'state', 'busy', 'cpu', 'ram', 'jobs']);
  assert.deepEqual(live.runners[0].jobs, [
    // The landing gate: 4 files selected over 2 runner shards, median 4 min each, 30 min in; nothing says done or failing yet.
    { kind: 'landing', item: 1196, selected: 4, done: null, failing: null, minutesLeft: 0 },
    { kind: 'test run', item: 41, selected: null, done: null, failing: null, minutesLeft: null },
  ]);
  assert.deepEqual(live.runners[2].jobs, [], 'an idle runner holds no jobs');
  assert.deepEqual(live.runners[3].jobs, [{ kind: 'gate', item: 52, selected: 3, done: null, failing: null, minutesLeft: 10 }],
    'a pulled gate names its repo-relative files: 2 + 4 + 6 min recorded, 2 min in');
  const counted = publicSnapshot({ live: sources({ job: { progress: { finished: 2, failures: 1 } } }) }).live;
  assert.deepEqual(counted.runners[3].jobs, [{ kind: 'gate', item: 52, selected: 3, done: 2, failing: 1, minutesLeft: 4 }],
    'a runner progress step gives done and failing; the rest of the time is the unfinished share');
  assert.deepEqual(estimateLeft({ selected: 3, elapsedMs: 0, fileTimes: {} }), null, 'no recorded time is no estimate');
});

test('view.live-runners.each-running-item-carries-per-file-state: each running item carries per-file state and the latest finished files when its runner reports them, null states otherwise [N26]', () => {
  const quiet = publicRunners(sources());
  const gate = quiet.runs.find(run => run.kind === 'gate');
  assert.deepEqual(gate.files, [{ file: 'apps/a.test.js', state: null }, { file: 'apps/b.test.js', state: null }, { file: 'apps/c.test.js', state: null }],
    'no progress step: the files are known, their state is not, and an absolute path is dropped');
  assert.deepEqual(gate.latest, []);
  assert.deepEqual(quiet.runs.find(run => run.kind === 'landing'), { kind: 'landing', item: 1196, items: [1196, 1197], runners: [1, 2], minutesRunning: 30,
    selected: 4, done: null, failing: null, minutesLeft: 0, files: null, latest: [] });
  const progress = { finished: 2, failures: 1, files: { 'apps/a.test.js': 'pass', 'apps/b.test.js': 'fail', 'apps/c.test.js': 'running' },
    latest: [{ file: 'apps/b.test.js', state: 'red' }, { file: '/home/user/x.test.js', state: 'green' }, { file: 'apps/a.test.js', state: 'green' }] };
  const reported = publicRunners(sources({ job: { progress } })).runs.find(run => run.kind === 'gate');
  assert.deepEqual(reported.files.map(entry => entry.state), ['green', 'red', 'running']);
  assert.deepEqual(reported.latest, [{ file: 'apps/b.test.js', state: 'red' }, { file: 'apps/a.test.js', state: 'green' }]);
  const partial = publicRunners(sources({ job: { progress: { files: [{ file: 'apps/a.test.js', state: 'green' }] } } })).runs.find(run => run.kind === 'gate');
  assert.deepEqual(partial.files.map(entry => entry.state), ['green', 'waiting', 'waiting'], 'once a runner reports files, the unreported ones are waiting');
});

test('view.live-runners.clause-2-runner-records-full-of-host: clause 2: runner records full of host names, addresses, users, seats, paths and run ids yield a snapshot with none of them [N26]', () => {
  const progress = { finished: 1, failures: 0, files: { 'apps/a.test.js': 'green' }, latest: ['apps/a.test.js'] };
  const text = JSON.stringify(publicSnapshot({ live: sources({ job: { progress } }) }));
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `the public snapshot leaks ${secret}`);
  assert.equal(text.includes('mini'), false);
  assert.match(text, /apps\/a\.test\.js/u, 'repo-relative test paths are public');
});

test('view.live-runners.the-fail-closed-text-blocks-still-refuse: the fail-closed text blocks still refuse a private name that reaches the runner projection [N26]', () => {
  const privateHost = ['test-host', 'local'].join('.');
  const leaked = sources({ job: { files: [`apps/${privateHost}/a.test.js`] } });
  assert.throws(() => publicSnapshot({ live: leaked }), error => error.code === 'PUBLIC_EXPORT_BLOCKED' && /machine or host name/u.test(error.message)
    && !error.message.includes('test-host'));
  assert.throws(() => publicSnapshot({ live: sources() }, { privateBoard: true }), /private item/u);
});

test('view.live-runners.n-5885-clause-1-the-anonymous-runner-snapshot: #5885 clause 1: the anonymous runner snapshot carries cpu, ram and busy per runner and no host, address or user name [N26]', () => {
  const raw = sources({ job: { progress: { finished: 1, load: { at: ago(0), average: [6, 5, 4], cpus: 8, freeMB: 4096, memoryMB: 16384 } } } });
  raw.runners[0].load = { busyPercent: 91.6, freeMB: 1024, memoryMB: 32768, host: 'runner-a.example.test', user: 'user', address: '192.0.2.98' };
  const { live } = publicSnapshot({ live: raw });
  assert.deepEqual(live.runners.map(({ runner, busy, cpu, ram }) => ({ runner, busy, cpu, ram })), [
    { runner: 1, busy: true, cpu: 92, ram: 97 },
    { runner: 2, busy: true, cpu: null, ram: null },
    { runner: 3, busy: false, cpu: null, ram: null },
    { runner: 4, busy: true, cpu: 75, ram: 75 },
  ], 'a sampled busy percent, else load over cores; RAM is the used share; an unsampled runner reads null');
  const text = JSON.stringify(live);
  for (const secret of [...SECRETS, 'mini', 'runner-a.example.test', '192.0.2.98']) assert.equal(text.includes(secret), false, `the runner load leaks ${secret}`);
  assert.equal(/freeMB|memoryMB|cpus|average|busyPercent/u.test(text), false, 'only the two percents leave the machine');
  assert.deepEqual(loadPercents({ average: [40], cpus: 8, freeMB: 9, memoryMB: 4 }), { cpu: 100, ram: 0 }, 'percents clamp to 0..100');
  assert.deepEqual(loadPercents(null), { cpu: null, ram: null });
});

test('view.live-runners.clause-1-a-run-listing-such-a: clause 1: a run listing such a file and a short one passes publicSnapshot and lists only the short one [N26]', () => {
  const digest = 'a1b2c3d4'.repeat(8);
  const long = 'packages/gate/tests/journey-parity-export-team-board.test.js';
  const hexed = `apps/view/tests/${digest}.test.js`;
  const { live } = publicSnapshot({ live: sources({ job: { files: ['apps/a.test.js', long, hexed], progress: { latest: [long, hexed, 'apps/a.test.js'], files: { 'apps/a.test.js': 'green' } } } }) });
  const gate = live.runs.find(run => run.kind === 'gate');
  assert.deepEqual(gate.files, [{ file: 'apps/a.test.js', state: 'green' }], 'the 40-character segment and the 64-hex name leave the list');
  assert.deepEqual(gate.latest, [{ file: 'apps/a.test.js', state: 'green' }]);
  const text = JSON.stringify(live);
  assert.equal(text.includes('journey-parity') || text.includes(digest), false);
});
