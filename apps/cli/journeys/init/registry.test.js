/** Init and opening a temporary board leave the person's project registry unchanged [I8,N26,N35]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';

test('init and opening a temporary board leave the person registry unchanged [I8,N26,N35]', t => {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-temp-open-')));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const repo = join(box, 'preview');
  mkdirSync(repo);
  const bin = resolve(import.meta.dirname, '../../pullboard.js');
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
  const script = `import { cli$main as main } from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};
import { serveView } from ${JSON.stringify(new URL('../../src/io/commands/view.js', import.meta.url).href)};
const result = await main(['view','--no-open','--port','0'], {
  cwd: process.cwd(), stdout: { isTTY: true, write() {} }, stderr: process.stderr,
  loadNativeBoard: () => import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)}),
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
