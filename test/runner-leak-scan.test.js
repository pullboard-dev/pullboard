/** Public negative-auth fixtures remain transferable without exempting secrets or private history [C7,S1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { secretsIn } from '../src/hooks.js';
import { runFixtureChild } from './fixture-child.js';
import { shellQuote } from './runner-ssh-fixture.js';

const SENTINEL = 'not-the-listener-secret';
const PRIVATE = ['ordinary', 'credential', 'value', '123456789'].join('-');

/** Scan one controlled line without returning its values in diagnostics. */
function findings(text) { return secretsIn([{ path: 'fixture.js', line: 1, text }]); }

test('only the exact public assigned-secret sentinel is safe [C7,S1]', () => {
  assert.deepEqual(findings(`secret: '${SENTINEL}'`), []);
  for (const value of [PRIVATE, SENTINEL + 'x', 'x' + SENTINEL]) {
    assert.deepEqual(findings(`secret: '${value}'`), ['assigned secret at fixture.js:1']);
  }
  for (const line of [`secret: '${SENTINEL}'; token: '${PRIVATE}'`,
    `password: '${PRIVATE}'; secret: '${SENTINEL}'`]) {
    assert.deepEqual(findings(line), ['assigned secret at fixture.js:1']);
  }
  const providerKey = ['sk', 'ant', 'a'.repeat(32)].join('-');
  assert.deepEqual(findings(`secret: '${SENTINEL}'; key: '${providerKey}'`), ['Anthropic key at fixture.js:1']);
  assert.deepEqual(findings(`FIXTURE_SECRET=${SENTINEL}`), ['env-style secret at fixture.js:1']);
});

/** Run ordinary private Git commands with actionable setup diagnostics. */
function git(root, env, ...args) {
  const result = runFixtureChild('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
  return result.stdout.trim();
}

for (const kind of ['current-sentinel', 'historical-sentinel', 'historical-secret']) {
  test(`runner transfer scans ${kind} with full Git history [C7,S1]`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'pullboard-leak-scan-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'repo'), bin = join(dir, 'bin'), marker = join(dir, 'ssh-started');
    mkdirSync(root); mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 97\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Leak Fixture', GIT_AUTHOR_EMAIL: 'leak@example.invalid',
      GIT_COMMITTER_NAME: 'Leak Fixture', GIT_COMMITTER_EMAIL: 'leak@example.invalid' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[name];
    git(root, env, 'init', '-q', '-b', 'main');
    const value = kind === 'historical-secret' ? PRIVATE : SENTINEL;
    writeFileSync(join(root, 'fixture.js'), `const record = { secret: '${value}' };\n`);
    git(root, env, 'add', '.'); git(root, env, 'commit', '-qm', 'test: public source history fixture');
    if (kind !== 'current-sentinel') {
      writeFileSync(join(root, 'fixture.js'), 'export const clean = true;\n');
      git(root, env, 'add', '.'); git(root, env, 'commit', '-qm', 'test: clean current source');
    }
    const runner = pathToFileURL(new URL('../src/runners.js', import.meta.url).pathname).href;
    const script = `import { runOnRunnerAsync } from ${JSON.stringify(runner)};
try { await runOnRunnerAsync(process.argv[1], 'true', { runner: { host: 'fixture.invalid', slots: 1, browser: 0 } }); }
catch (error) { process.stdout.write(JSON.stringify({ code: error.code ?? error.name })); }`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script, root], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, // Budget: private source scan and bounded SSH stand-in startup.
    });
    assert.equal(result.status, 0, result.context);
    const code = JSON.parse(result.stdout).code;
    if (kind === 'historical-secret') {
      assert.equal(code, 'RUNNER_SECRET');
      assert.equal(existsSync(marker), false, 'private historical bytes never reach SSH');
    } else {
      assert.notEqual(code, 'RUNNER_SECRET');
      assert.equal(existsSync(marker), true, 'the real full-history scan reaches transport');
    }
    assert.ok(!result.stdout.includes(PRIVATE), 'refusal never prints credential bytes');
  });
}
