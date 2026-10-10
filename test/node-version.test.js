/**
 * An older Node is told what to install (P3, P4). The board needs node:sqlite, which Node ships
 * unflagged from 22.13. The version is spoofed by a module preloaded with --import, so these tests
 * run on whatever Node runs the suite.
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync, runFixtureChild as spawnSync } from './fixture-child.js';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-node-')));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A module that makes this process report `version` as its Node, for --import. */
function spoof(version) {
  const file = join(dir, `node-${version}.mjs`);
  writeFileSync(file, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
  return file;
}

const refusal = (version) =>
  `pullboard: [NODE_TOO_OLD] this is Node ${version}, and pullboard needs Node 22.13 or newer: install it (for example nvm install 22), then run the command again\n`;

test('an older Node is told what to install, never a stack trace; 22.13 and newer run as before [P3, P4]', () => {
  for (const version of ['18.19.0', '20.11.1', '22.12.0']) {
    const result = spawnSync(process.execPath, ['--import', spoof(version), BIN, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${version} exits 1`);
    assert.equal(result.stderr, refusal(version), `${version} names what to install`);
    assert.equal(result.stdout, '', `${version} prints nothing else`);
  }
  for (const version of ['22.13.0', '24.0.0']) {
    const result = spawnSync(process.execPath, ['--import', spoof(version), BIN, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${version} runs: ${result.stderr}`);
    assert.match(result.stdout, /^New here\? pullboard tour, then pullboard init\.\nPullboard is a local-first work board/, `${version} prints the short overview`);
  }
});

test('the git hooks run the same command, so an older Node refuses a commit the same way [P3, P4]', () => {
  const shims = join(dir, 'bin');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_HOME: join(dir, 'home'),
  };
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
  execFileSync('pullboard', ['init'], { cwd: repo, env, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  const old = spawnSync('git', ['commit', '-q', '-m', 'chore: set up pullboard'], { cwd: repo, env: { ...env, NODE_OPTIONS: `--import ${spoof('20.11.1')}` }, encoding: 'utf8' });
  assert.notEqual(old.status, 0, 'the commit is refused');
  assert.ok(old.stderr.includes(refusal('20.11.1')), `the hook says what to install: ${old.stderr}`);
  const current = spawnSync('git', ['commit', '-q', '-m', 'chore: set up pullboard'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(current.status, 0, `under this Node the same commit goes through: ${current.stderr}`);
});


test('the real entrypoint versions old-Node refusals and honors JSON flag positioning [A1, P3, P4]', () => {
  for (const version of ['18.19.0', '20.11.1', '22.12.0']) {
    for (const args of [['--help', '--json'], ['--json', '--help'], ['help', '--json']]) {
      const result = spawnSync(process.execPath, ['--import', spoof(version), BIN, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 1, `${version}: ${args.join(' ')}`);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        version: 1,
        error: {
          code: 'NODE_TOO_OLD',
          message: refusal(version).replace(/^pullboard: \[NODE_TOO_OLD\] /, '').trimEnd(),
          next: 'install it (for example nvm install 22), then run the command again',
        },
      });
    }
    const literal = spawnSync(process.execPath, ['--import', spoof(version), BIN, 'help', '--', '--json'], { encoding: 'utf8' });
    assert.equal(literal.status, 1);
    assert.equal(literal.stdout, '');
    assert.equal(literal.stderr, refusal(version), '--json after -- is a positional, preserving ordinary guidance');
  }
  for (const version of ['22.13.0', '24.0.0', '26.0.0']) {
    for (const args of [['--help', '--json'], ['--json', '--help']]) {
      const result = spawnSync(process.execPath, ['--import', spoof(version), BIN, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${version}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      const document = JSON.parse(result.stdout);
      assert.equal(document.version, 1);
      assert.match(document.help, /^New here\? pullboard tour, then pullboard init\.\nPullboard is a local-first work board/);
    }
  }
});
