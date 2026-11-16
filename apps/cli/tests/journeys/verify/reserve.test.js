import * as fs from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runFixtureSetupGit } from '../../fixtures/child.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { settleSubmit } from '../../fixtures/submit/settle.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { fixtureJoin } from '../../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

/**
 * End the fixture's local runner at once. Why: it ignores SIGTERM for the whole 10 s stopFixtureLocalRunner allows before it kills it, and this case needs the runner only until its gate settles.
 *
 * @param {string} machineHome - The fixture's PULLBOARD_MACHINE_HOME.
 */
function killLocalRunner(machineHome) {
  let pid = 0;
  try { pid = Number(JSON.parse(fs.readFileSync(join(machineHome, 'local-runner', 'state.json'), 'utf8')).pid); } catch { return; }
  try { process.kill(pid, 'SIGKILL'); } catch { return; }
  for (const until = Date.now() + 2000; Date.now() < until;) {
    try { process.kill(pid, 0); } catch { return; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

test('next --verify reserves the review for the reviewLease and says until when; show names the holder; another verifier is passed over and refused [V15]', async (t) => {
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
    killLocalRunner(join(dir, 'home'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

