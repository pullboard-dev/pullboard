/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** Real gate, item-check and verifier profiles parse emitted timings [C7,V10]. */
import { awaitNestedRun } from '../../../../packages/gate/index.js';
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { listResources } from '../../../../packages/resources/index.js';
import { checkAtCommit } from '../../../runner/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const RUNNER = resolve(import.meta.dirname, '../../../../apps/cli/src/io/run/tests.js');
const CALLER_REPORTER = resolve(import.meta.dirname, '../../tests/fixtures/reporter.js');
const RESOURCE_MODULE = resolve(import.meta.dirname, '../../../../packages/resources/index.js');
const TEMP = [];
const SPEC = '# Demo\n\n## G · Goals\n- G1 [approved, must] The page renders. | gate: web test\n- G2 [approved, must] The API answers. | gate: api test\n';
const CONFIG = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/', '.timed/', 'timed/', 'apps/cli/src/io/run/tests.js'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } }, shared: ['docs/'] };
const FAKE_SECRET = 'ghp_' + 'A'.repeat(36);

// budget: run-tests SIGKILLs a file that has not exited 30 s after its last test, so cleanup stops retrying well inside that ceiling.
const CLEANUP_CEILING_MS = 15_000;

/**
 * Remove every fixture directory, retrying while a detached submit hand-off worker finishes its last writes.
 * rmSync's own maxRetries backs off linearly (100 retries at 300 ms blocked far past the 30 s file-exit
 * ceiling and the gate killed the file), so each attempt is short and the whole loop is bounded; a tree a
 * worker still holds at the ceiling stays in the run's temporary root and is named on stderr.
 */
after(() => {
  const deadline = Date.now() + CLEANUP_CEILING_MS;
  for (const dir of TEMP) {
    for (;;) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY') throw error;
        if (Date.now() < deadline) continue;
        process.stderr.write(`gate-profile cleanup left ${dir}: ${error.code} at ${error.path ?? dir} after ${CLEANUP_CEILING_MS} ms\n`);
        break;
      }
    }
  }
});

/** Create an isolated CLI sandbox and real local Git helpers. */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-profile-')));
  TEMP.push(dir);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const shims = join(dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: home,
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const runLocal = (cwd, ...args) => runCliInProcess(args, { cwd, env });
  return { dir, home, shims, env, git, runLocal };
}

/** Make installed Git hooks resolve the real private CLI after repository initialization. */
function installPrivatePullboardPath(box) {
  const entries = (box.env.PATH ?? '').split(':');
  box.env.PATH = [box.shims, ...entries.filter(entry => entry !== box.shims)].join(':');
}

/** Create a coordinator repo configured with one actual project gate. */
async function gateRepo(box, gate) {
  const repo = join(box.dir, 'gate-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  installPrivatePullboardPath(box);
  mkdirSync(join(repo, 'work'));
  writeFileSync(join(repo, 'work/owner.txt'), 'coordinator lane fixture\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate, spec: 'SPEC.md', verify: 'any', lanes: { work: { owns: ['work/'], specs: ['G1'] } } }, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure timing gate');
  const added = await fixtureAdd(box.runLocal, repo, 'work', 'Work');
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const lane = join(box.dir, 'work-1');
  box.git(repo, 'worktree', 'add', '-q', lane, '-b', 'work/one');
  const laneJoin = await joinFixtureSeat(box, lane, 'work', { run: box.runLocal });
  assert.equal(laneJoin.code, 0, laneJoin.err || laneJoin.out);
  assert.equal(JSON.parse(laneJoin.out).agent, 'work-1');
  const claimed = await box.runLocal(lane, 'claim', '1');
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  return { repo, ...box };
}

/** Create a project repo and one joined web worktree for CLI item-check fixtures. */
async function project(box = sandbox()) {
  const repo = join(box.dir, 'project-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await box.runLocal(repo, 'init')).status, 0);
  installPrivatePullboardPath(box);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up profile project');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const webJoin = await joinFixtureSeat(box, web, 'web', { run: box.runLocal });
  assert.equal(webJoin.code, 0, webJoin.err || webJoin.out);
  assert.equal(JSON.parse(webJoin.out).agent, 'web-1');
  return { ...box, repo, web };
}

/** Commit one actual lane change without involving board mutation. */
function featureCommit(box, cwd) {
  box.git(cwd, 'add', '-A');
  const tree = box.git(cwd, 'write-tree');
  const commit = box.git(cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', 'feat(web): add timing fixture [G1]');
  box.git(cwd, 'update-ref', 'HEAD', commit);
  return commit;
}

/** Hold the only private machine gate slot until the real gate queues behind it. */
async function occupyGateSlot(box, repo) {
  const source = `import { takeResource } from ${JSON.stringify(RESOURCE_MODULE)};\nconst lease = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: ${JSON.stringify(repo)}, agent: 'profile-test-holder' });\nconsole.log('ready');\nfor await (const line of process.stdin) if (line.trim() === 'release') { lease.release(); break; }`;
  // process-level: holds the machine gate slot until released.
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: repo, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('gate slot holder did not start')), 10_000); // budget: hang ceiling for the private gate holder readiness handshake.
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', data => {
      clearTimeout(timer);
      if (String(data).includes('ready')) resolveReady();
      else reject(new Error(`unexpected gate holder output: ${data}`));
    });
  });
  await ready;
  return child;
}

test('a timing profile records two runner invocations and the real gate-slot wait [C7,V10]', async () => {
  const box = sandbox();
  const slowName = `slow timing profile ${FAKE_SECRET}`;
  const fixture = await gateRepo(box, 'true');
  mkdirSync(join(fixture.repo, 'timed'));
  writeFileSync(join(fixture.repo, 'timed/fast.test.js'), "import { test } from 'node:test'; test('fast timing profile sample', async t => { await t.test('nested timing profile sample', () => {}); });\n");
  writeFileSync(join(fixture.repo, 'timed/slow.test.js'), `import { test } from 'node:test'; test(${JSON.stringify(slowName)}, async () => new Promise(resolve => setTimeout(resolve, 150)));\n`);
  writeFileSync(join(fixture.repo, 'timed/fail.test.js'), "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('failing timing profile sample', () => assert.equal(1, 2));\n");
  box.git(fixture.repo, 'add', 'timed');
  // The slow fixture's name carries FAKE_SECRET on purpose; the pre-commit secret scan would refuse this synthetic commit, so it skips that hook as the submit-profile case does.
  box.git(fixture.repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'test: add timing profile fixtures');
  const runner = `'${RUNNER.replaceAll("'", "'\\''")}'`;
  const command = `node ${runner} timed/fast.test.js && node ${runner} timed/slow.test.js`;
  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: command }));
  box.git(fixture.repo, 'add', 'pullboard.json');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: configure profiled runner gate');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const holder = await occupyGateSlot(box, fixture.repo);
  const holderExited = once(holder, 'exit');
  // process-level: the gate queues behind the held slot and is timed as a process.
  const gate = spawn(process.execPath, [BIN, 'gate'], { cwd: fixture.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const gateExited = once(gate, 'exit');
  const gateOutput = [];
  gate.stdout.on('data', chunk => gateOutput.push(chunk));
  gate.stderr.on('data', chunk => gateOutput.push(chunk));
  let result;
  const started = Date.now();
  const previousHome = process.env.PULLBOARD_HOME;
  const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.home;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let queued = false;
  let holderReleased = false;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      queued = listResources({ scope: 'machine', root: fixture.repo }).find(resource => resource.name === 'gate')?.line.some(waiter => waiter.agent !== 'profile-test-holder') ?? false;
      if (queued) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (queued) await new Promise(resolve => setTimeout(resolve, 300));
    if (holder.exitCode === null) {
      holderReleased = true;
      holder.stdin.end('release\n');
    }
    let gateTimer;
    const timeout = new Promise((_, reject) => {
      gateTimer = setTimeout(() => reject(new Error('private gate did not finish within 60 seconds')), 60_000); // budget: hang ceiling for private gate completion; no throughput claim.
    });
    let status;
    try {
      const terminal = Promise.race([gateExited, timeout]).catch(async error => {
        if (gate.exitCode === null && gate.signalCode === null) gate.kill('SIGTERM');
        await gateExited;
        throw error;
      });
      terminal.child = gate;
      [status] = await awaitNestedRun(terminal);
    }
    finally { clearTimeout(gateTimer); }
    result = { status, stdout: Buffer.concat(gateOutput).toString('utf8'), stderr: '' };
  } finally {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
    if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
    if (!holderReleased && holder.exitCode === null) holder.stdin.end('release\n');
    if (holder.exitCode === null) {
      await Promise.race([holderExited.catch(() => {}), new Promise(resolve => setTimeout(resolve, 2_000))]);
    }
    if (holder.exitCode === null) holder.kill('SIGTERM');
    if (gate.exitCode === null && gate.signalCode === null) gate.kill('SIGTERM');
    await Promise.allSettled([holderExited, gateExited]);
  }
  assert.ok(queued, 'the gate joined the real private machine queue');
  const elapsedMs = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /timing \(node(?: on runner [^)]*)?\): wall/);
  const profilePath = /timing profile: ([^\n]+)/.exec(result.stdout)?.[1];
  assert.ok(profilePath, result.stdout);
  assert.ok(profilePath.endsWith('pullboard-gate.log.profile.json'), 'the full gate profile is paired with its canonical raw log');
  assert.ok(existsSync(profilePath.slice(0, -'.profile.json'.length)));
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.equal(statSync(profilePath).mode & 0o777, 0o600);
  assert.ok(profile.waitMs >= 100, `recorded queue wait ${profile.waitMs}ms`); // budget: declared 300ms queue hold; recorded wait must include it.
  assert.ok(profile.wallMs > 0 && elapsedMs + 30 >= profile.waitMs + profile.wallMs, `${elapsedMs}ms total vs ${profile.waitMs}ms wait + ${profile.wallMs}ms wall`); // budget: measured queue and work durations compared to their enclosing clock; 30ms rounding allowance.
  assert.deepEqual(profile.files, [], 'ordinary TAP supplies no file wall measurements');
  assert.deepEqual(profile.tests.map(test => test.name).sort(), ['[redacted GitHub token]', 'fast timing profile sample', 'nested timing profile sample'].sort());
  assert.ok(profile.tests.find(test => test.name === '[redacted GitHub token]').durationMs >= 130, 'the actual slow test duration is retained'); // budget: declared 150ms slow-test sleep must appear in its timing profile.
  assert.doesNotMatch(result.stdout, /slowest test files:/);
  assert.ok(!result.stdout.includes(FAKE_SECRET));
  assert.ok(!readFileSync(profilePath, 'utf8').includes(FAKE_SECRET));
  assert.match(readFileSync(profilePath, 'utf8'), /redacted GitHub token/);

  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: `${command} && node ${runner} timed/fail.test.js` }));
  box.git(fixture.repo, 'add', 'pullboard.json');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: configure red profiled runner gate');
  const red = await box.runLocal(fixture.repo, 'gate');
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /gate red in \d+s:/);
  const redProfilePath = /timing profile: ([^\n]+)/.exec(red.stdout)?.[1];
  assert.ok(redProfilePath, red.stdout);
  const redProfile = JSON.parse(readFileSync(redProfilePath, 'utf8'));
  assert.equal(statSync(redProfilePath).mode & 0o777, 0o600);
  assert.equal(redProfile.tests.length, 4);
  assert.equal(redProfile.tests.find(test => test.name === 'failing timing profile sample').passed, false);
  assert.doesNotMatch(red.stdout, /slowest test files:/);
});

test('item-check and ACCEPT timing profiles sit beside their sanitized logs [C7,V10]', { skip: 'PULL_GAP #7301: the pulled gate receipt carries no check.profilePath or proofProfilePath; un-skipped by #7301' }, async t => {
  const box = await project();
  const projectConfig = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...projectConfig, verify: { policy: 'any', unrelatedTrunkMoves: false } }, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: preserve unaffected profile review');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  const runner = `'${RUNNER.replaceAll("'", "'\\''")}'`;
  const command = `node ${runner} .timed/fast.test.js .timed/slow.test.js`;
  mkdirSync(join(box.repo, '.timed'));
  writeFileSync(join(box.repo, '.timed/fast.test.js'), "import { test } from 'node:test'; test('fast timing profile check', () => {});\n");
  writeFileSync(join(box.repo, '.timed/slow.test.js'), "import { test } from 'node:test'; test('slow timing profile check', async () => new Promise(resolve => setTimeout(resolve, 40)));\n");
  writeFileSync(join(box.repo, '.timed/middle.test.mjs'), "import { test } from 'node:test'; test('buried timing profile sample', () => {});\n");
  writeFileSync(join(box.repo, '.timed/middle-output.mjs'), "import {spawnSync} from 'node:child_process'; const noise=['-e',\"process.stdout.write(('harmless padding '.repeat(30)+'\\\\n').repeat(10000))\"]; spawnSync(process.execPath,noise,{stdio:'inherit'}); const child=spawnSync(process.execPath,['--test-reporter=tap','.timed/middle.test.mjs'],{stdio:'inherit'}); spawnSync(process.execPath,noise,{stdio:'inherit'}); process.exitCode=child.status;\n");
  box.git(box.repo, 'add', '.timed');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add timing profile check fixtures');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Profiled check', '--specs', 'G1', '--criterion', 'the runner writes timings', '--check', command)).status, 0);
  box.env.CODEX_THREAD_ID = 'profile-builder-session';
  const claimedOne = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimedOne.status, 0, `${claimedOne.stdout}${claimedOne.stderr}`);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/timing.txt'), 'profiled');
  const commit = featureCommit(box, box.web);

  const direct = await box.runLocal(box.web, 'check', '--yes');
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /timing \(node(?: on runner [^)]*)?\): wall/);
  const directPath = /timing profile: ([^\n]+)/.exec(direct.stdout)?.[1];
  assert.ok(directPath, direct.stdout);
  assert.equal(statSync(directPath).mode & 0o777, 0o600);
  const directProfile = JSON.parse(readFileSync(directPath, 'utf8'));
  assert.deepEqual(directProfile.files, []);
  assert.ok(directProfile.tests.find(test => test.name === 'slow timing profile check').durationMs >= 30); // budget: declared 40ms slow-test sleep must appear in its timing profile.
  assert.ok(existsSync(directPath.slice(0, -'.profile.json'.length) + '.log'));

  const submitted = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
  // The submit queues a pulled gate job; its receipt's gate carries the profiles the runner wrote [P7,C7].
  const submission = await settleSubmit(t, { repo: box.repo, env: box.env, run: async (cwd, ...args) => {
    const result = await box.runLocal(cwd, ...args);
    return { code: result.status, out: result.stdout, err: result.stderr };
  } }, JSON.parse(submitted.stdout));
  assert.ok(submission.gate.check.profilePath && submission.gate.proofProfilePath, 'native submit retains both authentic phase profiles');
  for (const profilePath of [submission.gate.check.profilePath, submission.gate.proofProfilePath, submission.gate.profilePath]) {
    assert.ok(profilePath && existsSync(profilePath), `submit profile is retained: ${profilePath}`);
    assert.equal(statSync(profilePath).mode & 0o777, 0o600);
    assert.ok(existsSync(profilePath.slice(0, -'.profile.json'.length)), 'the corresponding sanitized raw log remains beside its profile');
  }
  // Main moves a file the check names, so the sealed submit proof cannot stand and the check runs again.
  writeFileSync(join(box.repo, '.timed/fast.test.js'), "import { test } from 'node:test'; test('fast timing profile check', () => {}); // main context\n");
  box.git(box.repo, 'add', '.timed/fast.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: advance a file the check names');
  const review = join(box.dir, 'timing-profile-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  box.env.CODEX_THREAD_ID = 'profile-reviewer-session';
  const reviewJoin = await joinFixtureSeat(box, review, 'api', { run: box.runLocal });
  assert.equal(reviewJoin.code, 0, reviewJoin.err || reviewJoin.out);
  const accepted = await box.runLocal(review, 'verify', '1', 'accept', '--note', 'timings were retained');
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /submit proof not reused:/u, 'main advancement creates a new accepted composition and executes its check');
  assert.match(accepted.stdout, /timing \(node(?: on runner [^)]*)?\): wall/);
  const verifyPath = /timing profile: ([^\n]+)/.exec(accepted.stdout)?.[1];
  assert.ok(verifyPath, accepted.stdout);
  assert.ok(verifyPath.endsWith('.log.profile.json'), accepted.stdout);
  assert.equal(statSync(verifyPath).mode & 0o777, 0o600);
  assert.equal(statSync(verifyPath.slice(0, -'.profile.json'.length)).mode & 0o777, 0o600);
  const verified = JSON.parse(readFileSync(verifyPath, 'utf8'));
  assert.ok(verified.waitMs >= 0 && verified.wallMs > 0);
  const reviewBoard = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let checkedHead;
  try {
    checkedHead = store.verdictsFor(reviewBoard, 1).at(-1)?.review?.head;
  } finally { store.closeBoard(reviewBoard); }
  assert.ok(checkedHead, 'the sealed fresh ACCEPT review names its actual checked composition');
  assert.notEqual(checkedHead, commit, 'unrelated main advancement produced a new composed commit');
  assert.equal(box.git(review, 'show', `${checkedHead}:.timed/fast.test.js`).includes('// main context'), true,
    'the checked composition includes the moved main file');
  assert.deepEqual(verified.files, []);
  assert.ok(verified.tests.find(test => test.name === 'slow timing profile check').durationMs >= 30); // budget: declared 40ms slow-test sleep must appear in its timing profile.
  box.env.CODEX_THREAD_ID = 'profile-builder-session';
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');

  const shellAdded = await fixtureAdd(box.runLocal, box.repo, 'web', 'Shell-only check', '--specs', 'G1', '--criterion', 'shell-only checks still save timings', '--check', 'true');
  assert.equal(shellAdded.status, 0, shellAdded.stderr || shellAdded.stdout);
  assert.equal((await box.runLocal(box.web, 'claim', '2')).status, 0);
  const shellCheck = await box.runLocal(box.web, 'check', '2', '--yes');
  assert.equal(shellCheck.status, 0, shellCheck.stderr);
  const gitDirectory = box.git(box.web, 'rev-parse', '--absolute-git-dir');
  const shellProfileName = readdirSync(gitDirectory).find(name => name.startsWith('pullboard-check-2-') && name.endsWith('.profile.json'));
  assert.ok(shellProfileName, 'a shell-only direct check persists its timing profile');
  const shellProfilePath = join(gitDirectory, shellProfileName);
  const shellProfile = JSON.parse(readFileSync(shellProfilePath, 'utf8'));
  assert.equal(statSync(shellProfilePath).mode & 0o777, 0o600);
  assert.ok(existsSync(shellProfilePath.slice(0, -'.profile.json'.length) + '.log'));
  assert.deepEqual(shellProfile.files, []);
  assert.deepEqual(shellProfile.tests, []);
  assert.ok(shellProfile.wallMs > 0);

  writeFileSync(join(box.web, 'web/shell-only.txt'), 'shell only');
  const shellCommit = featureCommit(box, box.web);
  const shellSubmitted = await box.runLocal(box.web, 'submit', '2', '--json');
  assert.equal(shellSubmitted.status, 0, shellSubmitted.stderr || shellSubmitted.stdout);
  const shellSubmission = JSON.parse(shellSubmitted.stdout);
  assert.ok(shellSubmission.gate.check.profilePath && shellSubmission.gate.proofProfilePath, 'shell submit retains the two authentic execution profiles');
  for (const profilePath of [shellSubmission.gate.check.profilePath, shellSubmission.gate.proofProfilePath, shellSubmission.gate.profilePath]) {
    assert.ok(profilePath && existsSync(profilePath), `submit profile is retained: ${profilePath}`);
    assert.equal(statSync(profilePath).mode & 0o777, 0o600);
    assert.ok(existsSync(profilePath.slice(0, -'.profile.json'.length)));
  }
  const shellReviewer = join(box.dir, 'shell-timing-profile-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', shellReviewer, shellCommit);
  box.env.CODEX_THREAD_ID = 'profile-reviewer-session';
  const reviewerJoin = await joinFixtureSeat(box, shellReviewer, 'api', { run: box.runLocal });
  assert.equal(reviewerJoin.code, 0, reviewerJoin.err || reviewerJoin.out);
  const shellAccepted = await box.runLocal(shellReviewer, 'verify', '2', 'accept', '--note', 'reuse the authentic submit profile');
  assert.equal(shellAccepted.status, 0, shellAccepted.stderr || shellAccepted.stdout);
  assert.match(shellAccepted.stdout, /reused submit proof/u);
  assert.doesNotMatch(shellAccepted.stdout, /timing profile:/u, 'reuse does not invent a verifier profile for work it did not run');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try {
    item = store.getItem(board, 2);
    const nativeProofIds = new Set(store.proofReceipts(board, 2).map(receipt => receipt.id));
    const reusedIds = /reused submit proof ([a-f0-9-]{36}(?:, [a-f0-9-]{36})*)/u.exec(shellAccepted.stdout)?.[1].split(', ') ?? [];
    assert.ok(reusedIds.length > 0, 'the exact-source ACCEPT cites native submit proof ids');
    for (const receiptId of reusedIds) assert.ok(nativeProofIds.has(receiptId), `reused verdict cites actual board receipt ${receiptId}`);
  } finally { store.closeBoard(board); }
  const frozen = JSON.parse(item.item_frozen);
  const shellVerify = checkAtCommit(box.repo, { ...item, item_commit: shellCommit, item_frozen: JSON.stringify({ ...frozen, check: 'true' }) }, { waitMs: 17 });
  assert.equal(shellVerify.state, 'pass');
  assert.deepEqual(shellVerify.profile.files, []);
  assert.deepEqual(shellVerify.profile.tests, []);
  assert.equal(shellVerify.profile.waitMs, 17); // budget: declared synthetic waitMs=17 input is retained exactly, not elapsed wall work.
  assert.ok(shellVerify.profile.wallMs > 0 && existsSync(shellVerify.profilePath));
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let buried;
  try { buried = checkAtCommit(box.repo, { ...item, item_commit: shellCommit, item_frozen: JSON.stringify({ ...frozen, check: 'node .timed/middle-output.mjs' }) }); }
  finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }

  assert.equal(buried.state, 'pass', buried.report);
  assert.doesNotMatch(buried.output, /buried timing profile sample/u, 'the bounded worker capture omits the middle');
  assert.ok(buried.profile.tests.some(value => value.name === 'buried timing profile sample'), 'the complete private log retains middle timing data');

});


test('a timing profile keeps every selected file while its digest names only ten [C7,V10]', async () => {
  const box = sandbox();
  const fixture = await gateRepo(box, 'true');
  mkdirSync(join(fixture.repo, 'timed'));
  const paths = Array.from({ length: 12 }, (_, index) => `timed/selected-${index}.test.js`);
  for (const [index, path] of paths.entries()) {
    writeFileSync(join(fixture.repo, path), `import { test } from 'node:test'; test('selected timing case ${index}', () => {});\n`);
  }
  writeFileSync(join(fixture.repo, 'timed/unselected.test.js'), "throw new Error('an unselected file must not run');\n");
  const command = `node '${RUNNER.replaceAll("'", "'\\''")}' --test-reporter='${CALLER_REPORTER}' ${paths.join(' ')}`;
  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: command }));
  box.git(fixture.repo, 'add', '-A');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: select twelve timing files');
  const result = await box.runLocal(fixture.repo, 'gate');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const profilePath = /timing profile: ([^\n]+)/.exec(result.stdout)?.[1];
  assert.ok(profilePath, result.stdout);
  assert.ok(profilePath.endsWith('pullboard-gate.log.profile.json'), 'the full gate profile is paired with its canonical raw log');
  assert.ok(existsSync(profilePath.slice(0, -'.profile.json'.length)));
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.deepEqual(profile.files.map(file => file.path).sort(), paths.slice().sort());
  assert.equal(profile.tests.length, paths.length, 'all selected top-level cases are recorded exactly once');
  const digest = result.stdout.split('slowest test files:\n')[1].split('\ntiming profile:')[0].split('\n');
  assert.equal(digest.length, 10, 'the digest is bounded to ten files');
  const slowest = profile.files.slice().sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
  assert.deepEqual(digest, slowest.map(file => `  ${file.path}: ${(file.durationMs / 1000).toFixed(2)}s`));

  writeFileSync(join(fixture.repo, 'timed/crash.test.js'), 'process.exit(7);\n');
  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: `node '${RUNNER.replaceAll("'", "'\\''")}' timed/crash.test.js` }));
  box.git(fixture.repo, 'add', '-A');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: profile a crashing test file');
  const crashed = await box.runLocal(fixture.repo, 'gate');
  assert.equal(crashed.status, 1, crashed.stdout);
  const crashPath = /timing profile: ([^\n]+)/.exec(crashed.stdout)?.[1];
  assert.ok(crashPath, crashed.stdout);
  const crashProfile = JSON.parse(readFileSync(crashPath, 'utf8'));
  assert.deepEqual(crashProfile.files.map(file => file.path), ['timed/crash.test.js']);
  assert.ok(crashProfile.files[0].durationMs > 0, 'a crashed process has its measured file duration');
  assert.deepEqual(crashProfile.tests, [], 'the process wrapper is not an actual test case');
});
