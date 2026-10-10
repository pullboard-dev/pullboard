/** Registry metadata, refresh, pruning and forgetting (N33, N35, N36). */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn, reportFixtureChildFailure, runFixtureGit } from './fixture-child.js';
import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { configProblems, defaults, loadConfig } from '../src/config.js';
import { forgetProject, listProjects, registerProject, registryFile } from '../src/projects.js';

/**
 * Create an initialized temporary Git repository with a private Pullboard home.
 *
 * @param {string} parent
 * @param {string} name
 * @returns {string}
 */
function makeRepo(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  runFixtureGit(['init', '--quiet', root]);
  return root;
}

test('registry uses validated repo labels, refreshes metadata, prunes missing roots and forgets one path [N33, N35, N36]', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-registry-'));
  const home = join(sandbox, 'private-home');
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  try {
    const first = makeRepo(sandbox, 'first-repo');
    const second = makeRepo(sandbox, 'second-repo');
    writeFileSync(join(first, 'pullboard.json'), JSON.stringify({ name: 'Core API', project: 'Atlas', gate: '' }));
    assert.equal(loadConfig(first).name, 'Core API');
    assert.equal(registerProject(first, new Date('2026-01-02T03:04:05.000Z'), loadConfig(first)), true);
    assert.equal(registerProject(second, new Date('2026-01-03T03:04:05.000Z')), true);

    let projects = listProjects();
    assert.deepEqual(projects.map(({ name, project }) => ({ name, project })), [
      { name: 'Core API', project: 'Atlas' },
      { name: basename(second), project: '' },
    ]);
    const firstAdded = projects[0].added;

    writeFileSync(join(first, 'pullboard.json'), JSON.stringify({ name: 'Core API v2', project: 'Atlas One', gate: '' }));
    projects = listProjects();
    assert.equal(projects[0].name, 'Core API v2');
    assert.equal(projects[0].project, 'Atlas One');
    assert.equal(projects[0].added, firstAdded);
    const unchangedRegistry = readFileSync(registryFile(), 'utf8');
    assert.deepEqual(listProjects(), projects);
    assert.equal(readFileSync(registryFile(), 'utf8'), unchangedRegistry, 'unchanged metadata is not rewritten');

    writeFileSync(join(first, 'pullboard.json'), JSON.stringify({ name: ' invalid ', project: 'Atlas', gate: '' }));
    assert.throws(() => loadConfig(first), /"name"/);
    assert.equal(listProjects()[0].name, 'Core API v2', 'invalid current config cannot erase stored metadata');
    assert.equal(registerProject(first), false);
    assert.equal(listProjects()[0].name, 'Core API v2', 'registration with invalid config preserves stored metadata');
    assert.ok(configProblems({ ...defaults(), name: 'bad,name', project: '' }).some((problem) => problem.includes('"name"')));
    assert.ok(configProblems({ ...defaults(), name: 'valid', project: 'bad\u0001value' }).some((problem) => problem.includes('"project"')));

    rmSync(second, { recursive: true, force: true });
    assert.deepEqual(listProjects().map((project) => project.root), [first]);
    assert.equal(forgetProject(resolve(first, '..', basename(first))), true);
    assert.equal(forgetProject(first), false);
    assert.deepEqual(listProjects(), []);
  } finally {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * Start a child Node process and expose its ready signal and exit result.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ child: import('node:child_process').ChildProcess, ready: Promise<void>, exited: Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string }> }}
 */
function startNode(args, env) {
  const command = process.execPath;
  const started = performance.now();
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let announcedReady = false;
  let failureReported = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    if (!announcedReady && chunk.includes('ready')) {
      announcedReady = true;
      resolveReady();
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => {
    failureReported = true;
    reportFixtureChildFailure({ command, args, status: null, signal: null, elapsedMs: performance.now() - started, stderr, env, detail: error.message });
    rejectReady(error);
  });
  const exited = new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      if ((code !== 0 || signal) && !failureReported) {
        failureReported = true;
        reportFixtureChildFailure({ command, args, status: code, signal, elapsedMs: performance.now() - started, stderr, env, detail: announcedReady ? '' : 'child exited before ready' });
      }
      if (!announcedReady) rejectReady(new Error(`child exited before ready (${code ?? signal}): ${stderr}`));
      resolvePromise({ code, signal, stderr });
    });
  });
  return { child, ready, exited };
}

/**
 * Release one synchronized burst of registry processes and require every one to finish cleanly.
 *
 * @param {string} sandbox
 * @param {string} label
 * @param {string[]} roots
 * @param {string} forgotten
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
async function runRegistryBurst(sandbox, label, roots, forgotten, env) {
  const barrier = join(sandbox, `${label}.start`);
  const worker = `import { existsSync } from 'node:fs';
import { registerProject, forgetProject, listProjects } from ${JSON.stringify(new URL('../src/projects.js', import.meta.url).href)};
const [operation, root, barrier] = process.argv.slice(1);
console.log('ready');
while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 1));
if (operation === 'forget') forgetProject(root);
else if (operation === 'list') listProjects();
else registerProject(root);`;
  const jobs = [
    ...roots.map((root) => ['register', root]),
    ['forget', forgotten],
    ['list', ''],
  ];
  const children = jobs.map(([operation, root]) => startNode([
    '--input-type=module', '-e', worker, operation, root, barrier,
  ], env));
  await Promise.all(children.map(({ ready }) => ready));
  writeFileSync(barrier, 'go');
  const results = await Promise.all(children.map(({ exited }) => exited));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
}

/**
 * Read and compare the durable registry after one concurrent mutation burst.
 *
 * @param {Set<string>} expected
 * @param {string} forgotten
 * @param {string} gone
 */
function assertRegistry(expected, forgotten, gone) {
  const listed = JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map((project) => project.root);
  assert.equal(listed.length, expected.size);
  assert.deepEqual([...listed].sort(), [...expected].sort());
  assert.equal(listed.includes(forgotten), false);
  assert.equal(listed.includes(gone), false);
}

test('parallel processes preserve 30 registrations across a killed lock owner [N35, I8]', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-registry-race-'));
  const home = join(sandbox, 'private-home');
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  try {
    const gone = makeRepo(sandbox, 'gone');
    registerProject(gone);
    rmSync(gone, { recursive: true, force: true });
    const env = { ...process.env, PULLBOARD_HOME: home };
    const expected = new Set();
    const controlForgotten = makeRepo(sandbox, 'control-forgotten');
    registerProject(controlForgotten);
    const controlRoots = Array.from({ length: 30 }, (_, index) => makeRepo(sandbox, `control-${index}`));
    await runRegistryBurst(sandbox, 'control', controlRoots, controlForgotten, env);
    for (const root of controlRoots) expected.add(resolve(root));
    assertRegistry(expected, controlForgotten, gone);

    const lockFile = `${registryFile()}.lock.sqlite`;
    for (let round = 0; round < 8; round += 1) {
      const deadOwner = `import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(${JSON.stringify(lockFile)});
database.exec('PRAGMA busy_timeout = 30000; BEGIN IMMEDIATE; UPDATE registry_lock SET generation = generation + 1 WHERE id = 1');
console.log('ready');
setInterval(() => {}, 1000);`;
      const owner = startNode(['--input-type=module', '-e', deadOwner], env);
      await owner.ready;
      owner.child.kill('SIGKILL');
      assert.equal((await owner.exited).signal, 'SIGKILL', `round ${round + 1} owner was killed`);

      const forgotten = makeRepo(sandbox, `forgotten-${round}`);
      registerProject(forgotten);
      const roots = Array.from({ length: 30 }, (_, index) => makeRepo(sandbox, `round-${round}-${index}`));
      await runRegistryBurst(sandbox, `round-${round}`, roots, forgotten, env);
      for (const root of roots) expected.add(resolve(root));
      assertRegistry(expected, forgotten, gone);
    }
  } finally {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
