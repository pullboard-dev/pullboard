/**
 * pullboard update across the three install kinds, run as the real CLI in a child (C7, #1303).
 * A launcher placed where each kind installs Pullboard starts the real entrypoint, so the child classifies
 * itself from that path; a stub npm and npx first on PATH keep every run off the network.
 */
import assert from 'node:assert/strict';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';

// Process-level by nature: the install kind is read from the running script's own path, which only a fresh node process can model.
const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const { root: dir } = privateFixtureFiles('pullboard-update-');
after(() => rmSync(dir, { recursive: true, force: true }));

const NEWEST = '9.9.9';
const CHANGELOG = '# Changelog\n\n## [9.9.9] - 2099-01-01\n\nnewest-fix-line\n\n## [9.9.8] - 2099-01-01\n\nolder-fix-line\n\n## [0.0.1] - 2000-01-01\n\nancient-line\n';

/** A stub `npm` and `npx` that answer `npm view` with the newest version and log every other call. */
function stubs(name) {
  const bin = join(dir, name, 'bin');
  const log = join(dir, name, 'calls.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = view ]; then echo ${NEWEST}; exit 0; fi\necho "npm $*" >> "${log}"\n`);
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "npx $*" >> "${log}"\n`);
  for (const tool of ['npm', 'npx']) chmodSync(join(bin, tool), 0o755);
  return { bin, log };
}

/** A launcher at `folder`/pullboard.js that serves the fixture changelog, then starts the real entrypoint. */
function launcher(folder) {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'pullboard.js');
  writeFileSync(file, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const read = fs.readFileSync;',
    `fs.readFileSync = (path, ...rest) => String(path).endsWith('/CHANGELOG.md') ? ${JSON.stringify(CHANGELOG)} : read(path, ...rest);`,
    'syncBuiltinESMExports();',
    `await import(${JSON.stringify(pathToFileURL(BIN).href)});`,
    '',
  ].join('\n'));
  return file;
}

/** Run the launcher as `pullboard update` with the install's own PWD and prefix, as that kind's environment would have them. */
function update(name, script, extra = {}) {
  const tools = stubs(name);
  const cwd = extra.PWD ?? dir;
  const result = spawnSync(process.execPath, [script, 'update'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: `${tools.bin}:/usr/bin:/bin`, HOME: join(dir, name, 'home'), PULLBOARD_HOME: join(dir, name, 'pb-home'), ...extra, PWD: cwd },
  });
  let calls = '';
  try { calls = readFileSync(tools.log, 'utf8'); } catch { /* no upgrade ran */ }
  return { result, calls };
}

test('cli.journeys-version-update.each-install-kind-upgrades: clause 1: for each of global, npx and project, pullboard update runs that kind\'s upgrade through the stub npm on PATH and prints the changelog sections between the two versions [C7,#1303]', () => {
  const installs = {
    global: { script: launcher(join(dir, 'global', 'prefix', 'lib', 'node_modules', 'pullboard', 'apps', 'cli')), extra: { npm_config_prefix: join(dir, 'global', 'prefix') }, line: 'npm install -g pullboard@latest' },
    npx: { script: launcher(join(dir, 'npx', 'cache', '_npx', 'abc', 'node_modules', 'pullboard', 'apps', 'cli')), extra: {}, line: 'npx --yes pullboard@latest --version' },
    project: { script: launcher(join(dir, 'project', 'app', 'node_modules', 'pullboard', 'apps', 'cli')), extra: { PWD: join(dir, 'project', 'app') }, line: 'npm install --save-dev pullboard@latest' },
  };
  for (const [kind, install] of Object.entries(installs)) {
    const { result, calls } = update(kind, install.script, install.extra);
    assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
    assert.equal(calls.trim(), install.line, `${kind} ran its own upgrade and nothing else`);
    assert.match(result.stdout, /newest-fix-line/u, kind);
    assert.match(result.stdout, /older-fix-line/u, kind);
    assert.doesNotMatch(result.stdout, /ancient-line/u, kind);
  }
});

test('cli.journeys-version-update.current-and-unknown-installs: clause 2: pullboard update says Pullboard is already current when the stub reports the running version, and refuses UPDATE_KIND_UNKNOWN naming the one manual command for an install it cannot tell [C7,#1303]', () => {
  const running = JSON.parse(spawnSync(process.execPath, [BIN, '--version', '--json'], { encoding: 'utf8' }).stdout).release;
  const folder = join(dir, 'current', 'prefix', 'lib', 'node_modules', 'pullboard', 'apps', 'cli');
  const script = launcher(folder);
  const tools = stubs('current');
  writeFileSync(join(tools.bin, 'npm'), `#!/bin/sh\nif [ "$1" = view ]; then echo ${running}; exit 0; fi\necho "npm $*" >> "${tools.log}"\n`);
  const current = spawnSync(process.execPath, [script, 'update'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${tools.bin}:/usr/bin:/bin`, HOME: join(dir, 'current', 'home'), PULLBOARD_HOME: join(dir, 'current', 'pb-home'), npm_config_prefix: join(dir, 'current', 'prefix'), PWD: dir },
  });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /already current/u);
  assert.throws(() => readFileSync(tools.log, 'utf8'), { code: 'ENOENT' }, 'no upgrade ran');

  const { result, calls } = update('unknown', launcher(join(dir, 'unknown', 'somewhere')), {});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UPDATE_KIND_UNKNOWN/u);
  assert.match(result.stderr, /npm install -g pullboard@latest/u);
  assert.equal(calls, '', 'an unknown install runs nothing');
});
