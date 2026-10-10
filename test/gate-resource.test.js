/** Real gates and item checks share the machine queue; landing priority and lease behavior stay intact [Q1,Q2,Q4,O5,O6,V18]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, runFixtureChild as spawnSync, runFixtureChild } from './fixture-child.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP = [];
const CHILDREN = new Set();

/** Quote a fixture path for the gate shell command. */
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Create one private machine home, event file and isolated Git environment. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-queue-')));
  TEMP.push(dir);
  const events = join(dir, 'events.log');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Queue Test',
    GIT_AUTHOR_EMAIL: 'queue@example.invalid',
    GIT_COMMITTER_NAME: 'Queue Test',
    GIT_COMMITTER_EMAIL: 'queue@example.invalid',
    PULLBOARD_HOME: join(dir, 'home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'home'),
  };
  return { dir, events, env };
}

/** Create a clean gate repo whose start and end record observable execution, optionally waiting for a release file. */
function gateRepo(box, name, delay = 0.25, releaseFile = null) {
  const root = join(box.dir, name);
  mkdirSync(root);
  const git = (...args) => runFixtureChild('git', args, { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  const wait = releaseFile ? `while [ ! -e ${quote(releaseFile)} ]; do sleep 0.02; done` : `sleep ${delay}`;
  const command = `printf '${name} start\\n' >> ${quote(box.events)}; ${wait}; printf '${name} end\\n' >> ${quote(box.events)}`;
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: command }));
  writeFileSync(join(root, 'SPEC.md'), '# Queue fixture\n');
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'chore: queue fixture').status, 0);
  return root;
}

/** Launch a real gate CLI in its own process group and collect its output. */
function launch(box, root, args = ['gate']) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk; });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}

/** Create a real claimed item with a failing-at-baseline check that leaves an execution marker. */
function checkProject(box) {
  const root = join(box.dir, 'check-project');
  const runner = join(box.dir, 'check-runner');
  const script = join(box.dir, 'item-check.cjs');
  const shims = join(box.dir, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  box.env.PATH = `${shims}:${box.env.PATH}`;
  mkdirSync(root);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: box.env }).status, 0);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({
    gate: 'true',
    lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  }));
  writeFileSync(join(root, 'SPEC.md'), '# Queue fixture\n\n## G · Goals\n- G1 [approved, must] The check runs. | gate: test -f web/result.txt\n- G2 [approved, must] The API responds. | gate: test -f api/result.txt\n');
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: root, env: box.env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'chore: queue fixture'], { cwd: root, env: box.env }).status, 0);
  const initialized = spawnSync(process.execPath, [BIN, 'init'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', runner, '-b', 'web/runner'], { cwd: root, env: box.env }).status, 0);
  const joined = spawnSync(process.execPath, [BIN, 'join', 'web'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(joined.status, 0, joined.stderr);
  writeFileSync(script, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(box.events)}, 'item check\\n'); process.exitCode = fs.existsSync('web/result.txt') ? 0 : 1;\n`);
  const added = spawnSync(process.execPath, [BIN, 'add', 'web', 'Check item', '--specs', 'G1', '--route', 'light', '--criterion', 'the item check runs', '--check', `node '${script}'`, '--wait', '--brief', 'Files: web/result.txt\nTest: run the item check and observe its result.'], { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(spawnSync(process.execPath, [BIN, 'claim', '1'], { cwd: runner, env: box.env }).status, 0);
  writeFileSync(box.events, '');
  return { root, runner };
}

/** Wait until an observable fixture state is reached, or fail with a useful timeout. */
async function waitFor(predicate, description, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the current private event log. */
function events(box) {
  return existsSync(box.events) ? readFileSync(box.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
}

after(async () => {
  const running = [...CHILDREN];
  for (const child of running) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The fixture process already ended. */ }
  }
  await Promise.all(running.map((child) => child.closed));
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test('[Q4,O5,O6] gate processes run one at a time in FIFO order when machine slots are one', async () => {
  const box = fixture();
  const releaseFirst = join(box.dir, 'release-first');
  const roots = ['first', 'second', 'third'].map((name) => gateRepo(box, name, name === 'first' ? 0.1 : 0.2, name === 'first' ? releaseFirst : null));
  const setting = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1', '--json'], { cwd: roots[0], env: box.env, encoding: 'utf8' });
  assert.equal(setting.status, 0, setting.stderr);
  assert.equal(JSON.parse(setting.stdout).settings.gateSlots, 1);
  const first = launch(box, roots[0]);
  await waitFor(() => events(box).includes('first start') && !events(box).includes('first end'), 'first gate to remain active', 30_000);
  const second = launch(box, roots[1]);
  await waitFor(() => second.stdoutText.includes('place 1'), 'second gate to enter the FIFO line');
  assert.match(second.stdoutText, /1 running/);
  assert.ok(second.stdoutText.includes(roots[0]), 'wait report names the repo holding the slot');
  const third = launch(box, roots[2]);
  await waitFor(() => third.stdoutText.includes('place 2'), 'third gate to enter behind the second');
  assert.ok(events(box).includes('first start') && !events(box).includes('first end'), 'both successors queued while the first gate still held its slot');
  writeFileSync(releaseFirst, 'release\n');
  const results = await Promise.all([first.closed, second.closed, third.closed]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0, 0], `${first.stderrText}${second.stderrText}${third.stderrText}`);
  const starts = events(box).filter((line) => line.endsWith(' start')).map((line) => line.split(' ')[0]);
  assert.deepEqual(starts, ['first', 'second', 'third']);
  let running = 0;
  let maximum = 0;
  for (const line of events(box)) {
    if (line.endsWith(' start')) running += 1;
    else running -= 1;
    maximum = Math.max(maximum, running);
  }
  assert.equal(maximum, 1);
});

test('[Q4] gates with different PULLBOARD_HOME values share the machine pool unless explicitly separated', async () => {
  const shared = fixture();
  const releaseShared = join(shared.dir, 'release-shared');
  const firstRoot = gateRepo(shared, 'shared-first', 0, releaseShared);
  const otherBoardHome = { ...shared, env: { ...shared.env, PULLBOARD_HOME: join(shared.dir, 'other-board-home') } };
  const secondRoot = gateRepo(otherBoardHome, 'shared-second', 0, releaseShared);
  const setting = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: firstRoot, env: shared.env, encoding: 'utf8' });
  assert.equal(setting.status, 0, setting.stderr);
  const first = launch(shared, firstRoot);
  let second;
  try {
    await waitFor(() => events(shared).includes('shared-first start'), 'first shared-pool gate to start');
    second = launch(otherBoardHome, secondRoot);
    await waitFor(
      () => second.stdoutText.includes('place 1') || events(shared).includes('shared-second start'),
      'gate with another board home to queue or start on the shared machine pool',
    );
    assert.ok(second.stdoutText.includes('place 1'), 'the other board home is queued behind the first gate');
    assert.deepEqual(events(shared), ['shared-first start']);
    writeFileSync(releaseShared, 'release');
    const results = await Promise.all([first.closed, second.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${first.stderrText}${second.stderrText}`);
    assert.deepEqual(events(shared), ['shared-first start', 'shared-first end', 'shared-second start', 'shared-second end']);
  } finally {
    writeFileSync(releaseShared, 'release');
    await Promise.all([first, second].filter(Boolean).map((child) => child.closed));
  }

  const separated = fixture();
  const releaseSeparated = join(separated.dir, 'release-separated');
  const firstPool = { ...separated, env: { ...separated.env, PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-first') } };
  const secondPool = {
    ...separated,
    env: {
      ...separated.env,
      PULLBOARD_MACHINE_HOME: join(separated.dir, 'machine-second'),
    },
  };
  const isolatedFirstRoot = gateRepo(firstPool, 'isolated-first', 0, releaseSeparated);
  const isolatedSecondRoot = gateRepo(secondPool, 'isolated-second', 0, releaseSeparated);
  for (const [box, root] of [[firstPool, isolatedFirstRoot], [secondPool, isolatedSecondRoot]]) {
    const configured = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: root, env: box.env, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
  }
  const isolatedFirst = launch(firstPool, isolatedFirstRoot);
  let isolatedSecond;
  try {
    await waitFor(() => events(separated).includes('isolated-first start'), 'first isolated-pool gate to start');
    isolatedSecond = launch(secondPool, isolatedSecondRoot);
    await waitFor(() => events(separated).includes('isolated-second start'), 'explicit private pool to acquire while the first pool is occupied');
    assert.deepEqual(events(separated), ['isolated-first start', 'isolated-second start']);
    writeFileSync(releaseSeparated, 'release');
    const results = await Promise.all([isolatedFirst.closed, isolatedSecond.closed]);
    assert.deepEqual(results.map(({ code }) => code), [0, 0], `${isolatedFirst.stderrText}${isolatedSecond.stderrText}`);
    assert.deepEqual(events(separated).slice(0, 2), ['isolated-first start', 'isolated-second start']);
    assert.deepEqual(events(separated).slice(2).sort(), ['isolated-first end', 'isolated-second end']);
  } finally {
    writeFileSync(releaseSeparated, 'release');
    await Promise.all([isolatedFirst, isolatedSecond].filter(Boolean).map((child) => child.closed));
  }
});

test('[Q4] an exact-tree cached gate starts while another machine gate holds the only slot', async () => {
  const box = fixture();
  const cachedRoot = gateRepo(box, 'cached', 0.1);
  const releaseHolder = join(box.dir, 'release-holder');
  const holderRoot = gateRepo(box, 'holder', 0.1, releaseHolder);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: holderRoot, env: box.env }).status, 0);
  const warm = spawnSync(process.execPath, [BIN, 'gate'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(warm.status, 0, warm.stderr);
  const priorCount = events(box).filter((line) => line.startsWith('cached ')).length;
  const holder = launch(box, holderRoot);
  await waitFor(() => events(box).includes('holder start') && !events(box).includes('holder end'), 'uncached holder gate to remain active', 30_000);
  const refusedChange = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '2', '--json'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(refusedChange.status, 1);
  assert.equal(JSON.parse(refusedChange.stdout).error.code, 'RESOURCE_BUSY');
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).gateSlots, 1);
  const cached = runFixtureChild(process.execPath, [BIN, 'gate'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /already passed/);
  assert.ok(events(box).includes('holder start') && !events(box).includes('holder end'), 'cached gate returned while the other machine gate still held its slot');
  assert.equal(events(box).filter((line) => line.startsWith('cached ')).length, priorCount, 'cached gate command did not run again');
  writeFileSync(releaseHolder, 'release\n');
  assert.equal((await holder.closed).code, 0, holder.stderrText);
  assert.ok(events(box).includes('holder end'), 'the holder exits only after the test releases it');
});

test('[Q4] SIGKILL during a gate releases its machine slot for the next process', async () => {
  const box = fixture();
  const deadRoot = gateRepo(box, 'dead', 20);
  const nextRoot = gateRepo(box, 'next', 0.1);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: deadRoot, env: box.env }).status, 0);
  const dead = launch(box, deadRoot);
  await waitFor(() => events(box).includes('dead start'), 'gate to hold a slot before it is killed');
  const next = launch(box, nextRoot);
  await waitFor(() => next.stdoutText.includes('place 1'), 'successor gate to queue');
  process.kill(-dead.pid, 'SIGKILL');
  assert.equal((await dead.closed).signal, 'SIGKILL');
  const result = await Promise.race([
    next.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('successor did not acquire the freed slot')), 5_000)),
  ]);
  assert.equal(result.code, 0, next.stderrText);
  assert.ok(events(box).includes('next start'));
});

test('[Q1,Q2,V18] item checks wait for a gate slot and ordinary gates precede them', async () => {
  const box = fixture();
  const release = join(box.dir, 'release-holder');
  const firstRoot = gateRepo(box, 'slot-holder', 0.1, release);
  const nextRoot = gateRepo(box, 'ordinary-gate', 0.15);
  const { root, runner } = checkProject(box);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: firstRoot, env: box.env }).status, 0);

  const first = launch(box, firstRoot);
  await waitFor(() => events(box).includes('slot-holder start') && !events(box).includes('slot-holder end'), 'the first gate to hold the only slot');
  const check = launch(box, runner, ['check', '1', '--yes']);
  await waitFor(() => check.stdoutText.includes('place 1') || check.exitCode !== null, 'the item check to queue behind the running gate');
  assert.ok(check.stdoutText.includes('place 1'), 'the item check prints its queued gate-slot position');
  assert.match(check.stdoutText, /gate waiting:/);
  assert.deepEqual(events(box), ['slot-holder start'], 'the item check command has not started while the gate holds the slot');
  const ordinary = launch(box, nextRoot);
  await waitFor(() => /place [12]/u.test(ordinary.stdoutText), 'the later ordinary gate to enter the queue');
  assert.ok(ordinary.stdoutText.includes('place 1'), 'the ordinary gate is granted priority over the queued item check');
  assert.deepEqual(events(box), ['slot-holder start'], 'neither queued command runs before the holder releases');

  writeFileSync(release, 'release\n');
  await waitFor(() => events(box).includes('ordinary-gate start'), 'the waiting ordinary gate to acquire the released slot');
  assert.equal(events(box).includes('item check'), false, 'the ordinary gate starts before the lower-priority item check');
  await waitFor(() => events(box).includes('ordinary-gate end'), 'the ordinary gate to finish');
  const [firstResult, ordinaryResult, checkResult] = await Promise.all([first.closed, ordinary.closed, check.closed]);
  assert.equal(firstResult.code, 0);
  assert.equal(ordinaryResult.code, 0, ordinary.stderrText);
  assert.equal(checkResult.code, 1, check.stderrText);
  assert.deepEqual(events(box), ['slot-holder start', 'slot-holder end', 'ordinary-gate start', 'ordinary-gate end', 'item check']);

  mkdirSync(join(runner, 'web'));
  writeFileSync(join(runner, 'web', 'result.txt'), 'ready\n');
  assert.equal(spawnSync('git', ['add', 'web/result.txt'], { cwd: runner, env: box.env }).status, 0);
  const commit = spawnSync('git', ['commit', '-q', '-m', 'feat(web): queue item proof [G1]'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = spawnSync(process.execPath, [BIN, 'submit', '1'], { cwd: runner, env: box.env, encoding: 'utf8' });
  assert.equal(submitted.status, 0, submitted.stderr);
  const review = join(box.dir, 'check-review');
  const itemCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: runner, env: box.env, encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', ['worktree', 'add', '-q', '--detach', review, itemCommit], { cwd: root, env: box.env }).status, 0);
  const reviewer = spawnSync(process.execPath, [BIN, 'join', 'api'], { cwd: review, env: box.env, encoding: 'utf8' });
  assert.equal(reviewer.status, 0, reviewer.stderr);

  writeFileSync(box.events, '');
  const verifyRelease = join(box.dir, 'release-verify-holder');
  const verifyHolderRoot = gateRepo(box, 'verify-holder', 0.1, verifyRelease);
  const verifyNextRoot = gateRepo(box, 'verify-next-gate', 0.15);
  const verifyHolder = launch(box, verifyHolderRoot);
  await waitFor(() => events(box).includes('verify-holder start') && !events(box).includes('verify-holder end'), 'a gate to hold the slot before accepting an item');
  const verify = launch(box, review, ['verify', '1', 'accept', '--note', 'queue fixture']);
  await waitFor(() => verify.stdoutText.includes('place 1') || verify.exitCode !== null, 'verify accept to queue for the gate slot');
  assert.ok(verify.stdoutText.includes('place 1'), 'verify accept prints its queued gate-slot position');
  assert.match(verify.stdoutText, /gate waiting:/);
  const verifyNext = launch(box, verifyNextRoot);
  await waitFor(() => /place [12]/u.test(verifyNext.stdoutText), 'the ordinary gate to enter the queue ahead of accept');
  assert.ok(verifyNext.stdoutText.includes('place 1'), 'the ordinary gate is granted priority over the queued accept check');
  assert.equal(events(box).includes('item check'), false);
  writeFileSync(verifyRelease, 'release\n');
  await waitFor(() => events(box).includes('verify-next-gate start'), 'the waiting ordinary gate to acquire before accept');
  assert.equal(events(box).includes('item check'), false);
  await waitFor(() => events(box).includes('verify-next-gate end'), 'the ordinary gate before accept to finish');
  const [verifyHolderResult, verifyNextResult, verifyResult] = await Promise.all([verifyHolder.closed, verifyNext.closed, verify.closed]);
  assert.equal(verifyHolderResult.code, 0);
  assert.equal(verifyNextResult.code, 0, verifyNext.stderrText);
  assert.equal(verifyResult.code, 0, `${verify.stderrText}${verify.stdoutText}`);
  assert.deepEqual(events(box), ['verify-holder start', 'verify-holder end', 'verify-next-gate start', 'verify-next-gate end', 'item check']);
});
