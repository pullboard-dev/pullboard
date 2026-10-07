/** Registry metadata, refresh, pruning and forgetting (N33, N35, N36). */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  execFileSync('git', ['init', '--quiet', root]);
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
 * Run a child Node process and reject with its captured diagnostics on failure.
 *
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
function runNode(args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`child exited ${code}: ${stderr}`)));
  });
}

test('parallel processes preserve registrations and forget, and recover a crashed lock owner [N35, I8]', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pullboard-registry-race-'));
  const home = join(sandbox, 'private-home');
  const registryModule = new URL('../src/projects.js', import.meta.url).href;
  const barrier = join(sandbox, 'start');
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  try {
    const forgotten = makeRepo(sandbox, 'forgotten');
    const gone = makeRepo(sandbox, 'gone');
    const roots = Array.from({ length: 24 }, (_, index) => makeRepo(sandbox, `parallel-${index}`));
    registerProject(forgotten);
    registerProject(gone);
    rmSync(gone, { recursive: true, force: true });

    const worker = `import { existsSync } from 'node:fs';
import { registerProject, forgetProject, listProjects } from ${JSON.stringify(registryModule)};
const [operation, root, barrier] = process.argv.slice(1);
while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 1));
if (operation === 'forget') forgetProject(root);
else if (operation === 'list') listProjects();
else registerProject(root);`;
    const env = { ...process.env, PULLBOARD_HOME: home };
    const workers = [
      ...roots.map((root) => [worker, 'register', root, barrier]),
      [worker, 'forget', forgotten, barrier],
      [worker, 'list', '', barrier],
    ];
    const pending = workers.map((args) => runNode(['--input-type=module', '-e', args[0], ...args.slice(1)], env));
    writeFileSync(barrier, 'go');
    await Promise.all(pending);

    const listed = JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map((project) => project.root);
    assert.deepEqual(new Set(listed), new Set(roots));
    assert.equal(listed.includes(forgotten), false);
    assert.equal(listed.includes(gone), false);

    const lock = `${registryFile()}.lock`;
    const abandonedOwner = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(${JSON.stringify(lock)});
writeFileSync(${JSON.stringify(join(lock, 'owner.json'))}, JSON.stringify({ pid: process.pid, token: 'crashed' }));
console.log('lock-ready');
setInterval(() => {}, 1000);`;
    const crashedOwner = spawn(process.execPath, ['--input-type=module', '-e', abandonedOwner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = new Promise((resolvePromise, rejectPromise) => {
      crashedOwner.stdout.once('data', resolvePromise);
      crashedOwner.once('error', rejectPromise);
    });
    const exited = new Promise((resolvePromise) => {
      crashedOwner.once('close', (code, signal) => resolvePromise({ code, signal }));
    });
    await ready;
    crashedOwner.kill('SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
    const recovered = makeRepo(sandbox, 'after-crash');
    assert.equal(registerProject(recovered), true);
    assert.equal(existsSync(lock), false);
    assert.equal(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.length, roots.length + 1);
  } finally {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
