import * as fs from 'node:fs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runFixtureSetupGit } from '../../fixtures/child.js';
import { running } from '../../fixtures/runner/local-stop.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { settleSubmit } from '../../fixtures/submit/settle.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { fixtureJoin } from '../../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';
import { startFixtureChild } from '../../fixtures/child.js';
import { removeDrainedFixture } from '../../fixtures/verify/writers.js';

/**
 * End the fixture's local runner at once and assert it has exited. Why: it ignores SIGTERM for the whole 10 s stopFixtureLocalRunner allows before it kills it, and this case needs the runner only until its gate is done.
 * The runner records its pid in a state file and a starting marker, each keyed to PULLBOARD_HOME by a short hash (`state-<hash>.json`, `starting-<hash>.json`), so every such file under local-runner is read.
 *
 * @param {string} machineHome - The fixture's PULLBOARD_MACHINE_HOME.
 */
function killLocalRunner(machineHome) {
  const folder = join(machineHome, 'local-runner');
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => /^(?:state|starting)(?:-[0-9a-f]{12})?\.json$/u.test(name)) : [];
  // Only a pid the fixture runner wrote moments ago is signalled: an older file may name a pid another process now holds.
  const fresh = (state) => Date.now() - Number(state.heartbeatAt ?? state.startedAt) < 120_000;
  const pids = [...new Set(files.map((name) => {
    try {
      const state = JSON.parse(fs.readFileSync(join(folder, name), 'utf8'));
      return fresh(state) ? Number(state.pid) : 0;
    } catch { return 0; }
  }).filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid))];
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  // `running` ignores an exited child waiting to be reaped: this loop is blocked here, so it cannot reap it and a signal-zero would read it as alive for the whole wait.
  for (const until = Date.now() + 5000; Date.now() < until && pids.some(running);) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.deepEqual(pids.filter(running), [], 'the fixture local runner has exited before its home is removed');
}

test('cli.verify-reserve.lease-holder-refused: clause 1: next --verify reserves the review for the reviewLease and says until when; show names the holder; another verifier is passed over and refused [V15]', async (t) => {
  const dir = privateFixtureFiles('pullboard-reserve-').root;
  try {
    // A fixture seat never inherits the running agent's session: it joins with its own declared model.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CLAUDE|CODEX)/u.test(key))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Test Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      PULLBOARD_HOME: join(dir, 'home'),
      PULLBOARD_MACHINE_HOME: join(dir, 'home'),
    };
    const setupGit = (cwd, ...args) => runFixtureSetupGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    // The test runner's per-test timeout bounds hangs without killing this CLI early under load.
    // Each worktree is its own native session, so a peer's review is never skipped as the builder's own session.
    const sessions = new Map();
    const session = (cwd) => { if (!sessions.has(cwd)) sessions.set(cwd, `00000000-0000-4000-8000-${String(sessions.size + 1).padStart(12, '0')}`); return sessions.get(cwd); };
    // In process: a spawned CLI costs a second or more of start-up each, and this case makes eleven calls.
    const run = async (cwd, ...args) => runCliInProcess(args, { cwd, env: { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session(cwd) } });
    const repo = join(dir, 'repo');
    fs.mkdirSync(repo);
    setupGit(repo, 'init', '-q', '-b', 'main');
    fixtureProjectPolicy(repo, { config: { gate: 'true', reviewLease: '45m', lanes: { web: { owns: ['web/'] } } }, spec: '# Demo\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n' });
    setupGit(repo, 'add', '-A');
    setupGit(repo, 'commit', '-q', '-m', 'chore: a spec');
    const [builder, holder, other] = await Promise.all(['web-1', 'web-2', 'web-3'].map(async (name) => {
      const path = join(dir, name);
      setupGit(repo, 'worktree', 'add', '-q', '--detach', path);
      // Each seat declares its model; the builder's family differs so its peers may review it.
      const joined = await fixtureJoin(run, path, 'web', '--model', name === 'web-1' ? 'Builder Model' : 'Test Model', '--route', 'strong');
      assert.match(joined.stdout, new RegExp(`joined as ${name}`), joined.stderr);
      return path;
    }));
    const added = await fixtureAdd(run, repo, 'web', 'Greet', '--specs', 'G1', '--criterion', 'It greets.');
    assert.equal(added.status, 0, added.stderr);
    assert.equal((await run(builder, 'claim', '1')).status, 0);
    fs.mkdirSync(join(builder, 'web'));
    fs.writeFileSync(join(builder, 'web', 'greet.txt'), 'hello\n');
    setupGit(builder, 'add', '-A');
    setupGit(builder, 'commit', '-q', '-m', 'feat(web): greet [G1]');
    const commit = setupGit(builder, 'rev-parse', 'HEAD');
    const submitted = await run(builder, 'submit', '1', '--json');
    assert.equal(submitted.status, 0, submitted.stderr);
    // The submit queues its gate for the local runner; the review waits for that pulled gate to finish [P7].
    const showInProcess = async (cwd, ...args) => {
      const shown = await runCliInProcess(args, { cwd, env });
      return { code: shown.status, out: shown.stdout, err: shown.stderr };
    };
    const settled = await settleSubmit(t, { repo, env, run: showInProcess }, JSON.parse(submitted.stdout));
    assert.equal(settled.gate?.green ?? settled.gate?.ok, true, `the pulled gate is green: ${JSON.stringify(settled.gateJob)}`);
    // The gate is done; the verdicts below need no runner, and one still running would hand them a landing to finish.
    killLocalRunner(join(dir, 'home'));
    const commonDir = setupGit(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    assert.equal(setupGit(holder, 'rev-parse', '--path-format=absolute', '--git-common-dir'), commonDir,
      'the verifier worktree reads the builder repo common dir');
    const sharedBoard = new DatabaseSync(join(commonDir, 'pullboard', 'board.sqlite'), { readOnly: true });
    assert.equal(sharedBoard.prepare('PRAGMA user_version').get().user_version, 3,
      'the main repo creates the shared board before the verifier opens it');
    sharedBoard.close();

    const before = Date.now();
    const first = await run(holder, 'next', '--verify');
    const after = Date.now();
    assert.equal(first.status, 0, first.stderr);
    const until = /reserved for you until (\S+): another agent's verdict on it is refused until then/.exec(first.stdout)?.[1];
    assert.ok(until, first.stdout);
    const lease = 45 * 60_000;
    assert.ok(Date.parse(until) >= before + lease && Date.parse(until) <= after + lease, `${until} is 45 minutes on, the repo's reviewLease`);
    assert.ok((await run(repo, 'show', '1')).stdout.includes(`under review by web-2 (Test Model) until ${until}`), 'show names the holder and the time');

    const passed = await run(other, 'next', '--verify');
    assert.equal(passed.status, 1, passed.stdout);
    assert.match(passed.stderr, /NOTHING_FREE/);
    assert.ok(passed.stderr.includes(`web-2 (Test Model) holds the review of #1 until ${until}`), passed.stderr);
    setupGit(other, 'switch', '-q', '--detach', commit);
    const refused = await run(other, 'verify', '1', 'accept', '--note', 'it greets');
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /REVIEW_HELD/);
    assert.ok(refused.stderr.includes(`web-2 (Test Model) holds the review of #1 until ${until}`), refused.stderr);

    const renewed = await run(holder, 'next', '--verify');
    const again = /reserved for you until (\S+):/.exec(renewed.stdout)?.[1];
    assert.ok(again && Date.parse(again) > Date.parse(until), `running next --verify again renews the lease: ${renewed.stdout}${renewed.stderr}`);
    setupGit(holder, 'switch', '-q', '--detach', commit);
    const accepted = await run(holder, 'verify', '1', 'accept', '--note', 'checked out the commit; web/greet.txt says hello');
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    // The runner exit is asserted first; its detached comparison worker can still be writing, so the root is removed only once that has exited.
    killLocalRunner(join(dir, 'home'));
    await removeDrainedFixture(dir, { signal: t.signal });
  }
});


// A detached comparison-worker stand-in: it leads its own group, appends beside its request every 10 ms, and starts a
// child in that group that appends too; it prints the child's pid once both write.
const WRITER = `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
const inner = "const fs = require('node:fs'); const f = process.argv[1]; fs.appendFileSync(f, 'x'); setInterval(() => fs.appendFileSync(f, 'x'), 10); process.stdout.write('ready');";
const child = spawn(process.execPath, ['-e', inner, path.join(dir, 'child.txt')], { stdio: ['ignore', 'pipe', 'ignore'] });
setInterval(() => fs.appendFileSync(path.join(dir, 'parent.txt'), 'x'), 10);
child.stdout.once('data', () => process.stdout.write(child.pid + '\\n'));`;

/** Start a live writer group for a job folder, record it as the launcher does, and return it with its child's pid once both write. */
async function startWriter(job) {
  fs.mkdirSync(job, { recursive: true });
  const request = join(job, 'request.json');
  fs.writeFileSync(request, '{}\n');
  const writer = startFixtureChild(process.execPath, ['-e', WRITER, request], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = once(writer, 'close');
  fs.writeFileSync(join(job, 'worker.json'), JSON.stringify({ pid: writer.pid }) + '\n');
  const [line] = await once(writer.stdout, 'data');
  return { writer, closed, childPid: Number(String(line).trim()) };
}

test('cli.verify-reserve.cleanup-drains-owned-writer: clause 2: the reservation cleanup stops its recorded live comparison writer group before removing its root, and leaves a separately owned process and folder intact [V15,C7]', async (t) => {
  const owned = privateFixtureFiles('pullboard-reserve-owned-').root;
  const separate = privateFixtureFiles('pullboard-reserve-separate-').root;
  try {
    const jobs = join(owned, 'repo', '.git', 'pullboard', 'review-comparisons');
    const mine = await startWriter(join(jobs, 'owned-job'));
    // The worker writes result.json before it exits; that does not end its ownership.
    fs.writeFileSync(join(jobs, 'owned-job', 'result.json'), '{"code":0}\n');
    const other = await startWriter(join(separate, 'repo', '.git', 'pullboard', 'review-comparisons', 'other-job'));
    // A record inside the owned root that names the separate process: its command line names another root's request.
    fs.mkdirSync(join(jobs, 'foreign-job'));
    fs.writeFileSync(join(jobs, 'foreign-job', 'worker.json'), JSON.stringify({ pid: other.writer.pid }) + '\n');
    assert.ok(running(mine.writer.pid) && running(mine.childPid), 'the owned writer and its child are live before cleanup');

    const drained = await removeDrainedFixture(owned, { signal: t.signal });

    assert.deepEqual(drained, [mine.writer.pid], 'cleanup drains only the owned writer group');
    assert.deepEqual(await mine.closed, [null, 'SIGKILL'], 'the owned writer was stopped, not left writing');
    assert.equal(running(mine.childPid), false, 'the owned writer child in its group has exited too');
    assert.equal(fs.existsSync(owned), false, 'cleanup removed the whole private root');
    assert.equal(other.writer.exitCode, null, 'the separately owned process is still running');
    assert.equal(other.writer.signalCode, null, 'the separately owned process was not signalled');
    assert.ok(running(other.childPid), 'the separately owned child is still running');
    assert.ok(fs.statSync(join(separate, 'repo', '.git', 'pullboard', 'review-comparisons', 'other-job', 'parent.txt')).size > 0, 'the separate folder is intact');
  } finally {
    // Each root's own records drain its own writers, so the separate root is removed by the same cleanup.
    for (const root of [owned, separate]) if (fs.existsSync(root)) await removeDrainedFixture(root, { signal: t.signal });
  }
});
