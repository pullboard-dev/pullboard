/** Real gate, item-check and verifier profiles use Node's test events [C7,V10]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { listResources } from '../src/resources.js';
import { checkAtCommit } from '../src/trusted-policy.js';
import * as store from '../src/board.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const RUNNER = resolve(import.meta.dirname, '../bin/run-tests.js');
const RESOURCE_MODULE = resolve(import.meta.dirname, '../src/resources.js');
const TEMP = [];
const SPEC = '# Demo\n\n## G · Goals\n- G1 [approved, must] The page renders. | gate: web test\n- G2 [approved, must] The API answers. | gate: api test\n';
const CONFIG = { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } }, shared: ['docs/'] };
const FAKE_SECRET = 'ghp_' + 'A'.repeat(36);

after(() => { for (const dir of TEMP) rmSync(dir, { recursive: true, force: true }); });

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
  const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { dir, home, shims, env, git, run };
}

/** Make installed Git hooks resolve the real private CLI after repository initialization. */
function installPrivatePullboardPath(box) {
  const entries = (box.env.PATH ?? '').split(':');
  box.env.PATH = [box.shims, ...entries.filter(entry => entry !== box.shims)].join(':');
}

/** Create a coordinator repo configured with one actual project gate. */
function gateRepo(box, gate) {
  const repo = join(box.dir, 'gate-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate }));
  writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It works. | gate: test\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure timing gate');
  assert.equal(box.run(repo, 'add', 'coordinator', 'Work').status, 0);
  assert.equal(box.run(repo, 'claim', '1').status, 0);
  return { repo, ...box };
}

/** Create a project repo and one joined web worktree for CLI item-check fixtures. */
function project(box = sandbox()) {
  const repo = join(box.dir, 'project-repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').status, 0);
  installPrivatePullboardPath(box);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up profile project');
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  assert.match(box.run(web, 'join', 'web').stdout, /joined as web-1/);
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
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: repo, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('gate slot holder did not start')), 10_000);
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
  const fixture = gateRepo(box, 'true');
  mkdirSync(join(fixture.repo, 'timed'));
  writeFileSync(join(fixture.repo, 'timed/fast.test.js'), "import { test } from 'node:test'; test('fast timing profile sample', async t => { await t.test('nested timing profile sample', () => {}); });\n");
  writeFileSync(join(fixture.repo, 'timed/slow.test.js'), `import { test } from 'node:test'; test(${JSON.stringify(slowName)}, async () => new Promise(resolve => setTimeout(resolve, 150)));\n`);
  writeFileSync(join(fixture.repo, 'timed/fail.test.js'), "import assert from 'node:assert/strict'; import { test } from 'node:test'; test('failing timing profile sample', () => assert.equal(1, 2));\n");
  box.git(fixture.repo, 'add', 'timed');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: add timing profile fixtures');
  const runner = `'${RUNNER.replaceAll("'", "'\\''")}'`;
  const command = `node ${runner} timed/fast.test.js && node ${runner} timed/slow.test.js`;
  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: command }));
  box.git(fixture.repo, 'add', 'pullboard.json');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: configure profiled runner gate');
  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const holder = await occupyGateSlot(box, fixture.repo);
  const holderExited = once(holder, 'exit');
  const gate = spawn(process.execPath, [BIN, 'gate'], { cwd: fixture.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const gateExited = once(gate, 'exit');
  const gateOutput = [];
  gate.stdout.on('data', chunk => gateOutput.push(chunk));
  gate.stderr.on('data', chunk => gateOutput.push(chunk));
  let result;
  const started = Date.now();
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.home;
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
      gateTimer = setTimeout(() => reject(new Error('private gate did not finish within 60 seconds')), 60_000);
    });
    let status;
    try { [status] = await Promise.race([gateExited, timeout]); }
    finally { clearTimeout(gateTimer); }
    result = { status, stdout: Buffer.concat(gateOutput).toString('utf8'), stderr: '' };
  } finally {
    if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = previousHome;
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
  assert.match(result.stdout, /slowest test files:[\s\S]*slow\.test\.js:/);
  const profilePath = /timing profile: ([^\n]+)/.exec(result.stdout)?.[1];
  assert.ok(profilePath, result.stdout);
  assert.ok(profilePath.endsWith('pullboard-gate.log.profile.json'), 'the full gate profile is paired with its canonical raw log');
  assert.ok(existsSync(profilePath.slice(0, -'.profile.json'.length)));
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.equal(statSync(profilePath).mode & 0o777, 0o600);
  assert.ok(profile.waitMs >= 100, `recorded queue wait ${profile.waitMs}ms`);
  assert.ok(profile.wallMs > 0 && elapsedMs + 30 >= profile.waitMs + profile.wallMs, `${elapsedMs}ms total vs ${profile.waitMs}ms wait + ${profile.wallMs}ms wall`);
  assert.deepEqual(profile.files.map(file => file.path).sort(), ['timed/fast.test.js', 'timed/slow.test.js']);
  assert.deepEqual(profile.tests.map(test => test.name).sort(), ['[redacted GitHub token]', 'fast timing profile sample', 'nested timing profile sample'].sort());
  assert.ok(profile.files.find(file => file.path.endsWith('slow.test.js')).durationMs >= 130);
  assert.ok(profile.tests.find(test => test.name === '[redacted GitHub token]').durationMs >= 130, 'the actual slow test duration is retained');
  assert.match(result.stdout.split('slowest test files:\n')[1]?.split('\n')[0] ?? '', /^\s*timed\/slow\.test\.js:/);
  assert.ok(!result.stdout.includes(FAKE_SECRET));
  assert.ok(!readFileSync(profilePath, 'utf8').includes(FAKE_SECRET));
  assert.match(readFileSync(profilePath, 'utf8'), /redacted GitHub token/);

  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: `${command} && node ${runner} timed/fail.test.js` }));
  box.git(fixture.repo, 'add', 'pullboard.json');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: configure red profiled runner gate');
  const red = box.run(fixture.repo, 'gate');
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /gate red in \d+s:[\s\S]*slowest test files:[\s\S]*slow\.test\.js:/);
  const redProfilePath = /timing profile: ([^\n]+)/.exec(red.stdout)?.[1];
  assert.ok(redProfilePath, red.stdout);
  const redProfile = JSON.parse(readFileSync(redProfilePath, 'utf8'));
  assert.equal(statSync(redProfilePath).mode & 0o777, 0o600);
  assert.equal(redProfile.tests.length, 4);
  assert.equal(redProfile.tests.find(test => test.name === 'failing timing profile sample').passed, false);
  assert.match(red.stdout.split('slowest test files:\n')[1]?.split('\n')[0] ?? '', /^\s*timed\/slow\.test\.js:/);
});

test('item-check and ACCEPT timing profiles sit beside their sanitized logs [C7,V10]', () => {
  const box = project();
  const runner = `'${RUNNER.replaceAll("'", "'\\''")}'`;
  const command = `node ${runner} .timed/fast.test.js .timed/slow.test.js`;
  mkdirSync(join(box.repo, '.timed'));
  writeFileSync(join(box.repo, '.timed/fast.test.js'), "import { test } from 'node:test'; test('fast timing profile check', () => {});\n");
  writeFileSync(join(box.repo, '.timed/slow.test.js'), "import { test } from 'node:test'; test('slow timing profile check', async () => new Promise(resolve => setTimeout(resolve, 40)));\n");
  box.git(box.repo, 'add', '.timed');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add timing profile check fixtures');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.repo, 'add', 'web', 'Profiled check', '--specs', 'G1', '--criterion', 'the runner writes timings', '--check', command).status, 0);
  assert.equal(box.run(box.web, 'claim', '1').status, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/timing.txt'), 'profiled');
  const commit = featureCommit(box, box.web);

  const direct = box.run(box.web, 'check', '--yes');
  assert.equal(direct.status, 0, direct.stderr);
  assert.match(direct.stdout, /slowest test files:[\s\S]*slow\.test\.js:/);
  const directPath = /timing profile: ([^\n]+)/.exec(direct.stdout)?.[1];
  assert.ok(directPath, direct.stdout);
  assert.equal(statSync(directPath).mode & 0o777, 0o600);
  const directProfile = JSON.parse(readFileSync(directPath, 'utf8'));
  assert.ok(directProfile.files.some(file => file.path.endsWith('.timed/slow.test.js')));
  assert.ok(directProfile.tests.find(test => test.name === 'slow timing profile check').durationMs >= 30);
  assert.ok(existsSync(directPath.slice(0, -'.profile.json'.length) + '.log'));

  assert.equal(box.run(box.web, 'submit', '1').status, 0);
  const review = join(box.dir, 'timing-profile-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.match(box.run(review, 'join', 'api').stdout, /joined as api/);
  const accepted = box.run(review, 'verify', '1', 'accept', '--note', 'timings were retained');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /slowest test files:[\s\S]*slow\.test\.js:/);
  const verifyPath = /timing profile: ([^\n]+)/.exec(accepted.stdout)?.[1];
  assert.ok(verifyPath, accepted.stdout);
  assert.ok(verifyPath.endsWith('.log.profile.json'));
  assert.equal(statSync(verifyPath).mode & 0o777, 0o600);
  assert.equal(statSync(verifyPath.slice(0, -'.profile.json'.length)).mode & 0o777, 0o600);
  const verified = JSON.parse(readFileSync(verifyPath, 'utf8'));
  assert.ok(verified.waitMs >= 0 && verified.wallMs > 0);
  assert.ok(verified.files.some(file => file.path.endsWith('.timed/slow.test.js')));
  assert.ok(verified.tests.find(test => test.name === 'slow timing profile check').durationMs >= 30);

  assert.equal(box.run(box.repo, 'add', 'web', 'Shell-only check', '--specs', 'G1', '--criterion', 'shell-only checks still save timings', '--check', 'true').status, 0);
  assert.equal(box.run(box.web, 'claim', '2').status, 0);
  const shellCheck = box.run(box.web, 'check', '2', '--yes');
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
  assert.equal(box.run(box.web, 'submit', '2').status, 0);

  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 2); }
  finally { store.closeBoard(board); }
  const frozen = JSON.parse(item.item_frozen);
  const shellVerify = checkAtCommit(box.repo, { ...item, item_commit: shellCommit, item_frozen: JSON.stringify({ ...frozen, check: 'true' }) }, { waitMs: 17 });
  assert.equal(shellVerify.state, 'pass');
  assert.deepEqual(shellVerify.profile.files, []);
  assert.deepEqual(shellVerify.profile.tests, []);
  assert.equal(shellVerify.profile.waitMs, 17);
  assert.ok(shellVerify.profile.wallMs > 0 && existsSync(shellVerify.profilePath));
});


test('a timing profile keeps every selected file while its digest names only ten [C7,V10]', () => {
  const box = sandbox();
  const fixture = gateRepo(box, 'true');
  mkdirSync(join(fixture.repo, 'timed'));
  const paths = Array.from({ length: 12 }, (_, index) => `timed/selected-${index}.test.js`);
  for (const [index, path] of paths.entries()) {
    writeFileSync(join(fixture.repo, path), `import { test } from 'node:test'; test('selected timing case ${index}', () => {});\n`);
  }
  writeFileSync(join(fixture.repo, 'timed/unselected.test.js'), "throw new Error('an unselected file must not run');\n");
  const command = `node '${RUNNER.replaceAll("'", "'\\''")}' ${paths.join(' ')}`;
  writeFileSync(join(fixture.repo, 'pullboard.json'), JSON.stringify({ gate: command }));
  box.git(fixture.repo, 'add', '-A');
  box.git(fixture.repo, 'commit', '-q', '-m', 'test: select twelve timing files');
  const result = box.run(fixture.repo, 'gate');
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
  const crashed = box.run(fixture.repo, 'gate');
  assert.equal(crashed.status, 1, crashed.stdout);
  const crashPath = /timing profile: ([^\n]+)/.exec(crashed.stdout)?.[1];
  assert.ok(crashPath, crashed.stdout);
  const crashProfile = JSON.parse(readFileSync(crashPath, 'utf8'));
  assert.deepEqual(crashProfile.files.map(file => file.path), ['timed/crash.test.js']);
  assert.ok(crashProfile.files[0].durationMs > 0, 'a crashed process has its measured file duration');
  assert.deepEqual(crashProfile.tests, [], 'the process wrapper is not an actual test case');
});

/** Start a private submit process and collect its separate streams until close. */
function startProfiledSubmit(box, cwd) {
  const child = spawn(process.execPath, [BIN, 'submit', '1', '--json'], {
    cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const finished = new Promise(resolveFinished => child.once('close', (code, signal) => resolveFinished({
    code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
  })));
  return { child, finished };
}

/** Let one bounded timer settle while a private child or queue lease is cleaned up. */
function waitProfileCleanup(ms) {
  return new Promise(resolveCleanup => setTimeout(resolveCleanup, ms));
}

/** Copy the production runner's complete static import closure into the real fixture repo. */
function copyProfileRunner(box) {
  const source = resolve(import.meta.dirname, '..');
  mkdirSync(join(box.repo, 'bin'), { recursive: true });
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  for (const file of ['bin/run-tests.js', 'bin/gate-profile-reporter.js', 'src/person.js', 'src/refused.js']) {
    writeFileSync(join(box.repo, file), readFileSync(join(source, file)));
  }
}

/** Run one real submission with an optional real machine-slot wait and await every owned child. */
async function runProfileSubmission(box, queue) {
  const holder = queue ? await occupyGateSlot(box, box.repo) : null;
  const holderExited = holder
    ? (holder.exitCode === null ? once(holder, 'exit') : Promise.resolve())
    : null;
  const submit = startProfiledSubmit(box, box.web);
  const priorHome = process.env.PULLBOARD_HOME;
  const startedAt = Date.now();
  let queued = false;
  let released = false;
  let result;
  process.env.PULLBOARD_HOME = box.home;
  try {
    if (holder) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        queued = listResources({ scope: 'machine', root: box.repo })
          .find(resource => resource.name === 'gate')?.line.some(waiter => waiter.agent !== 'profile-test-holder') ?? false;
        if (queued || submit.child.exitCode !== null) break;
        await waitProfileCleanup(25);
      }
      if (queued) await waitProfileCleanup(300);
      if (holder.exitCode === null) {
        released = true;
        holder.stdin.end('release\n');
      }
    }
    let timer;
    try {
      result = await Promise.race([
        submit.finished,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('private profile submit exceeded 60 seconds')), 60_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    if (holder && holder.exitCode === null) {
      if (!released) holder.stdin.end('release\n');
      await Promise.race([holderExited, waitProfileCleanup(2_000)]);
      if (holder.exitCode === null) holder.kill('SIGTERM');
      if (holder.exitCode === null) await holderExited;
    }
    if (submit.child.exitCode === null && submit.child.signalCode === null) {
      submit.child.kill('SIGTERM');
      await submit.finished;
    }
  }
  return { result, queued, elapsedMs: Date.now() - startedAt };
}

test('a submit timing profile records both phases and one queue wait for selected and full proofs [C7,V4,V16]', async () => {
  for (const scenario of [
    { name: 'affected subset', full: false, queue: true },
    { name: 'full fallback', full: true, queue: false },
  ]) {
    const box = project();
    const trace = join(box.dir, `${scenario.name.replaceAll(' ', '-')}.trace`);
    box.env.PROFILE_TRACE = trace;
    mkdirSync(box.home, { recursive: true });
    writeFileSync(join(box.home, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
    const checkCommand = 'node bin/run-tests.js timed/check.test.js';
    const gateCommand = 'node bin/run-tests.js';
    writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ type: 'module' }));
    copyProfileRunner(box);
    mkdirSync(join(box.repo, 'timed'), { recursive: true });
    mkdirSync(join(box.repo, 'api'), { recursive: true });
    mkdirSync(join(box.repo, 'web'), { recursive: true });
    writeFileSync(join(box.repo, 'timed/check.test.js'), [
      "import { appendFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('frozen check profile sample [C7]', async () => {",
      "  appendFileSync(process.env.PROFILE_TRACE, 'check\\n');",
      '  await new Promise(resolve => setTimeout(resolve, 70));',
      '});',
    ].join('\n') + '\n');
    writeFileSync(join(box.repo, 'web/value.js'), 'export const value = 7;\n');
    writeFileSync(join(box.repo, 'web/affected.test.js'), [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "import { value } from './value.js';",
      "test('affected proof profile sample [C7]', () => {",
      "  appendFileSync(process.env.PROFILE_TRACE, 'web\\n');",
      '  assert.equal(value, 7);',
      '});',
    ].join('\n') + '\n');
    writeFileSync(join(box.repo, 'api/untouched.test.js'), [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('unaffected proof profile sample [C7]', () => {",
      "  appendFileSync(process.env.PROFILE_TRACE, 'api\\n');",
      '  assert.equal(1, 1);',
      '});',
    ].join('\n') + '\n');
    writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...CONFIG, gate: gateCommand }, null, 2));
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'test: build isolated submit profile fixture');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    const added = box.run(box.repo, 'add', 'web', `Profile ${scenario.name}`, '--specs', 'G1',
      '--criterion', 'submit profiles both check and proof', '--check', checkCommand, '--wait');
    assert.equal(added.status, 0, added.stderr || added.stdout);
    assert.equal(box.run(box.web, 'claim', '1').status, 0);
    writeFileSync(trace, ''); // Ignore the real --wait baseline execution in submission counts.
    writeFileSync(join(box.web, 'web/value.js'), 'export const value = 7; // changed lane module\n');
    if (scenario.full) writeFileSync(join(box.web, 'web/README.txt'), 'unsupported path forces the configured gate\n');
    featureCommit(box, box.web);

    const submission = await runProfileSubmission(box, scenario.queue);
    assert.equal(submission.result.code, 0, submission.result.stderr || submission.result.stdout);
    assert.equal(submission.queued, scenario.queue, `${scenario.name} observes only the planned real gate wait`);
    const receipt = JSON.parse(submission.result.stdout);
    const gate = receipt.gate;
    assert.equal(gate.green, true);
    assert.equal(gate.full, scenario.full);
    assert.equal(gate.check.green, true);
    assert.equal(gate.check.checked, true);
    assert.equal(gate.check.command, checkCommand);
    assert.equal(gate.reason === '', !scenario.full);
    if (scenario.full) assert.deepEqual(gate.files, ['api/untouched.test.js', 'timed/check.test.js', 'web/affected.test.js']);
    if (!scenario.full) assert.deepEqual(gate.files, ['web/affected.test.js']);
    if (scenario.full) assert.match(gate.reason, /web\/README\.txt/u);

    assert.ok(gate.check.log.endsWith('pullboard-submit.log.check.log'));
    assert.equal(gate.check.profilePath, `${gate.check.log}.profile.json`);
    assert.ok(existsSync(gate.check.log));
    assert.ok(gate.proofLog.endsWith('pullboard-submit.log.proof.log'));
    assert.equal(gate.proofProfilePath, `${gate.proofLog}.profile.json`);
    assert.ok(existsSync(gate.proofLog));
    assert.equal(gate.profilePath, `${gate.log}.profile.json`);
    assert.ok(existsSync(gate.log));

    const checkProfile = JSON.parse(readFileSync(gate.check.profilePath, 'utf8'));
    if (scenario.queue) assert.ok(checkProfile.waitMs >= 100, `actual queued check waited ${checkProfile.waitMs}ms`);
    const proofProfile = JSON.parse(readFileSync(gate.proofProfilePath, 'utf8'));
    const combined = JSON.parse(readFileSync(gate.profilePath, 'utf8'));
    assert.deepEqual(checkProfile.files.map(file => file.path), ['timed/check.test.js']);
    assert.ok(checkProfile.files[0].durationMs >= 50, 'the check profile retains the real slow check file duration');
    assert.equal(checkProfile.tests[0].name, 'frozen check profile sample [C7]');
    assert.ok(checkProfile.tests[0].durationMs >= 50);
    assert.deepEqual(proofProfile.files.map(file => file.path).sort(), scenario.full
      ? ['api/untouched.test.js', 'timed/check.test.js', 'web/affected.test.js']
      : ['web/affected.test.js']);
    assert.ok(proofProfile.files.every(file => file.durationMs > 0));
    assert.equal(proofProfile.waitMs, 0, 'the second phase reuses the submission lease instead of queueing again');
    assert.equal(combined.waitMs, checkProfile.waitMs, 'the combined profile records the real queue wait once');
    assert.ok(combined.wallMs >= checkProfile.wallMs + proofProfile.wallMs - 25,
      'the combined wall time includes both measured phases without adding their queue waits');
    assert.ok(submission.elapsedMs + 50 >= combined.waitMs + combined.wallMs,
      `${submission.elapsedMs}ms total vs ${combined.waitMs}ms one wait + ${combined.wallMs}ms combined work`);
    assert.ok(combined.files.some(file => file.path === 'timed/check.test.js'));
    assert.ok(combined.files.some(file => file.path === 'web/affected.test.js'));
    if (scenario.full) assert.ok(combined.files.some(file => file.path === 'api/untouched.test.js'));

    const ran = readFileSync(trace, 'utf8').trim().split(/\r?\n/u).sort();
    assert.equal(ran.filter(line => line === 'check').length, scenario.full ? 2 : 1,
      'the item check runs once; a full fallback also includes that file in its test suite');
    assert.equal(ran.filter(line => line === 'web').length, 1);
    assert.equal(ran.filter(line => line === 'api').length, scenario.full ? 1 : 0,
      'unaffected files run only when selection correctly falls back to the full gate');
  }
});
