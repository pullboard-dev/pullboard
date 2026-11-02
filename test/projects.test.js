/** Disposable boards do not enter the person's project inventory [I8,N26,N35]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { projectRegistrationAllowed } from '../packages/seats/src/shell/project-registration.js';
import { registerProject, registryFile } from '../src/projects.js';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

/** Change only fixture-owned environment keys and restore them after the test. */
function environment(t, values) {
  const prior = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('temporary roots and symlinked previews stay out of the person inventory [I8,N26,N35]', t => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-project-exclusion-')));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const repo = join(box, 'preview');
  mkdirSync(repo);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo });
  const alias = join(box, 'preview-link');
  symlinkSync(repo, alias, 'dir');
  environment(t, { HOME: join(box, 'person'), PULLBOARD_HOME: undefined, PULLBOARD_MACHINE_HOME: undefined,
    NODE_TEST_CONTEXT: undefined, PULLBOARD_TEST_RUNNER_PID: undefined, PULLBOARD_TRANSIENT: undefined });
  assert.equal(registerProject(repo), false);
  assert.equal(registerProject(alias), false);
  assert.equal(existsSync(registryFile()), false, 'exclusion does not even create the person registry');
  for (const root of ['/tmp/agent-preview', '/private/tmp/agent-preview', '/var/tmp/agent-preview']) {
    assert.equal(projectRegistrationAllowed(root, {}), false, root);
  }
});

test('agent scratch and explicit transient previews are excluded without hiding ordinary agent projects [I8,N26]', t => {
  environment(t, { HOME: resolve('/', 'person-home') });
  const home = homedir();
  for (const root of [join(home, '.claude', 'projects', 'session', 'scratchpad', 'board'),
    join(home, '.codex', 'scratch', 'board'), join(home, '.claude', 'worktrees', 'preview')]) assert.equal(projectRegistrationAllowed(root, {}), false);
  const durable = resolve('/', 'person-projects', 'application');
  assert.equal(projectRegistrationAllowed(durable, { AI_AGENT: 'codex' }), true);
  assert.equal(projectRegistrationAllowed(durable, { PULLBOARD_TRANSIENT: '1' }), false);
  assert.equal(projectRegistrationAllowed(durable, { NODE_TEST_CONTEXT: 'child-v8' }), false);
});

test('init and opening a temporary board leave the person registry unchanged [I8,N26,N35]', t => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-temp-open-')));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const repo = join(box, 'preview');
  mkdirSync(repo);
  const bin = resolve(import.meta.dirname, '../bin/pullboard.js');
  const shims = join(box, 'bin');
  mkdirSync(shims);
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = { ...process.env, HOME: join(box, 'person'), PULLBOARD_VIEW_BACKGROUND: 'off',
    PATH: `${shims}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Project fixture', GIT_AUTHOR_EMAIL: 'project@example.invalid',
    GIT_COMMITTER_NAME: 'Project fixture', GIT_COMMITTER_EMAIL: 'project@example.invalid' };
  for (const key of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'NODE_TEST_CONTEXT', 'PULLBOARD_TEST_RUNNER_PID']) delete env[key];
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  runFixtureGit(['config', 'user.name', 'Project fixture'], { cwd: repo, env });
  runFixtureGit(['config', 'user.email', 'project@example.invalid'], { cwd: repo, env });
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'chore: fixture repository'], { cwd: repo, env });
  const registry = join(env.HOME, '.pullboard', 'projects.json');
  mkdirSync(join(env.HOME, '.pullboard'), { recursive: true });
  const before = '{"projects":[],"fixture":"preserve these exact bytes"}\n';
  writeFileSync(registry, before);
  const init = runFixtureChild(process.execPath, [bin, 'init', '--yes', '--no-permissions', '--no-hooks', '--model', 'fixture', '--json'],
    { cwd: repo, env, encoding: 'utf8' });
  assert.equal(init.status, 0, `${init.context}\n${init.stdout}`);
  assert.equal(readFileSync(registry, 'utf8'), before, 'init does not register the preview');
  const script = `import { main } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
import { serveView } from ${JSON.stringify(new URL('../src/serve.js', import.meta.url).href)};
const result = await main(['view','--no-open','--port','0'], {
  cwd: process.cwd(), stdout: { isTTY: true, write() {} }, stderr: { write() {} },
  loadNativeBoard: () => import(${JSON.stringify(new URL('../src/native-board.js', import.meta.url).href)}),
  serveView: async options => {
    const view = await serveView(options);
    setImmediate(() => setImmediate(() => process.emit('SIGINT')));
    return view;
  }
});
if (result !== 0) throw new Error('view failed: ' + result);`;
  const opened = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: repo, env: { ...env, PULLBOARD_VIEW_FOREGROUND: '1' }, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.context);
  assert.equal(readFileSync(registry, 'utf8'), before, 'opening the real HTTP view does not register the preview');
});

test('a normal repository remains listed and a custom registry does not admit temporary boards [I8,N26]', t => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-project-registry-')));
  const repo = mkdtempSync(join(process.cwd(), '.project-test-'));
  t.after(() => { rmSync(box, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo });
  environment(t, { PULLBOARD_HOME: join(box, 'registry'), NODE_TEST_CONTEXT: undefined,
    PULLBOARD_TEST_RUNNER_PID: undefined, PULLBOARD_TRANSIENT: undefined });
  assert.equal(registerProject(box), false, 'a custom registry is still a project list');
  assert.equal(registerProject(repo, new Date('2026-10-27T00:00:00Z'), { name: 'Application' }), true);
  assert.deepEqual(JSON.parse(readFileSync(registryFile(), 'utf8')).projects.map(({ root, name }) => ({ root, name })),
    [{ root: repo, name: 'Application' }]);
});
