/** @pullboard-test-input source-cell packages/commits packages/runners */
/** Public negative-auth fixtures remain transferable without exempting secrets or private history [C7,S1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { secretsIn } from '../../../index.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { HOST } from '../../../../gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../gate/tests/fixtures/runner/ssh.js';
import { shellQuote } from '../../../../gate/tests/fixtures/runner/ssh.js';

const SENTINEL = 'not-the-listener-secret';
const PRIVATE = ['ordinary', 'credential', 'value', '123456789'].join('-');

/** Scan one controlled line without returning its values in diagnostics. */
function findings(text) { return secretsIn([{ path: 'fixture.js', line: 1, text }]); }

test('commits.runner-scan-leak.only-the-exact-public-assigned-secret: only the exact public assigned-secret sentinel is safe [C7,S1]', () => {
  assert.deepEqual(findings(`const record = { secret: '${SENTINEL}' };`), []);
  assert.deepEqual(findings(`const record = { secret: "${SENTINEL}" };`), []);
  assert.deepEqual(findings(`writeFileSync(sessionPath, JSON.stringify({ ...JSON.parse(sessionBytes), secret: '${SENTINEL}' }));`), []);
  for (const value of [PRIVATE, SENTINEL + 'x', 'x' + SENTINEL]) {
    assert.deepEqual(findings(`secret: '${value}'`), ['assigned secret at fixture.js:1']);
  }
  for (const line of [`secret: '${SENTINEL}'; token: '${PRIVATE}'`,
    `password: '${PRIVATE}'; secret: '${SENTINEL}'`]) {
    assert.deepEqual(findings(line), ['assigned secret at fixture.js:1']);
  }
  for (const value of [`'${SENTINEL}' + '${PRIVATE}'`, `"${SENTINEL}" + "${PRIVATE}"`,
    `'${SENTINEL}' /* continuation */ + '${PRIVATE}'`, `'${SENTINEL}'\n + '${PRIVATE}'`,
    `'${SENTINEL}' || '${PRIVATE}'`, `'${SENTINEL}'.concat('${PRIVATE}')`,
    `'${SENTINEL}'[0]`, `'${SENTINEL}' , '${PRIVATE}'`, `'${SENTINEL}"`,
    `'${SENTINEL}'\n}`, `'${SENTINEL}'`]) {
    assert.deepEqual(findings(`const record = { secret: ${value}`), ['assigned secret at fixture.js:1']);
  }
  assert.deepEqual(findings(`const secret = '${SENTINEL}';`), ['assigned secret at fixture.js:1']);
  assert.deepEqual(findings(`const record = { secret: '${SENTINEL}', token: '${PRIVATE}' };`), ['assigned secret at fixture.js:1']);
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

for (const kind of ['current-sentinel', 'historical-sentinel', 'historical-secret', 'current-concatenation', 'historical-concatenation']) {
  test(`runner transfer scans ${kind} with full Git history [C7,S1]`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'pullboard-leak-scan-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, 'repo'), bin = join(dir, 'bin'), marker = join(dir, 'command-ran');
    const worker = join(dir, 'worker'), home = join(dir, 'home'), machineHome = join(home, '.pullboard');
    const remoteHome = join(dir, 'remote-home'), remoteMachineHome = join(remoteHome, '.pullboard');
    const requests = join(dir, 'requests.jsonl');
    for (const folder of [root, bin, worker, home, machineHome, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'module' }));
    installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
    const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Leak Fixture', GIT_AUTHOR_EMAIL: 'leak@example.invalid',
      GIT_COMMITTER_NAME: 'Leak Fixture', GIT_COMMITTER_EMAIL: 'leak@example.invalid' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[name];
    git(root, env, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
    const refused = kind === 'historical-secret' || kind.endsWith('concatenation');
    const value = kind.endsWith('concatenation') ? `'${SENTINEL}' + '${PRIVATE}'`
      : `'${kind === 'historical-secret' ? PRIVATE : SENTINEL}'`;
    writeFileSync(join(root, 'fixture.js'), `const record = { secret: ${value} };\n`);
    git(root, env, 'add', '.'); git(root, env, 'commit', '-qm', 'test: public source history fixture');
    const oldBlob = git(root, env, 'rev-parse', 'HEAD:fixture.js');
    if (kind.startsWith('historical-')) {
      writeFileSync(join(root, 'fixture.js'), 'export const clean = true;\n');
      git(root, env, 'add', '.'); git(root, env, 'commit', '-qm', 'test: clean current source');
    }
    const head = git(root, env, 'rev-parse', 'HEAD');
    const commandScript = `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(${JSON.stringify(marker)}, cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());`;
    const command = `node -e ${shellQuote(commandScript)}`;
    const runner = pathToFileURL(new URL('../../../../runners/src/io/main.js', import.meta.url).pathname).href;
    const script = `import { runOnRunnerAsync } from ${JSON.stringify(runner)};
try { const run = await runOnRunnerAsync(process.argv[1], ${JSON.stringify(command)}, { runner: { host: ${JSON.stringify(HOST)}, slots: 1, browser: 0 }, metadata: { item: 'fixture', kind: 'remote-command' } });
process.stdout.write(JSON.stringify({ code: 'COMPLETED', exitCode: run.exitCode, commit: run.executionSource.commit })); }
catch (error) { process.stdout.write(JSON.stringify({ code: error.code ?? error.name })); }`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script, root], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, // Budget: original bounded child lifetime, now including real private worker protocol.
    });
    assert.equal(result.status, 0, result.context);
    const outcome = JSON.parse(result.stdout);
    const code = outcome.code;
    if (refused) {
      assert.equal(code, 'RUNNER_SECRET');
      assert.equal(existsSync(marker), false, 'historical-secret refusal happens before the requested command');
      const repositories = join(remoteHome, '.pullboard-runner', 'repos');
      if (kind.startsWith('historical-')) assert.ok(existsSync(repositories), 'historical refusal follows the actual cache inventory');
      for (const name of (existsSync(repositories) ? readdirSync(repositories) : []).filter(name => name.endsWith('.git'))) {
        const probe = runFixtureChild('git', ['--git-dir', join(repositories, name), 'cat-file', '-e', oldBlob], { env, encoding: 'utf8' });
        assert.notEqual(probe.status, 0, 'the secret-bearing historical blob was never transferred');
      }
    } else {
      assert.deepEqual(outcome, { code: 'COMPLETED', exitCode: 0, commit: head });
      assert.equal(readFileSync(marker, 'utf8'), head, 'the actual command runs at the exact selected source HEAD');
    }
    assert.ok(!result.stdout.includes(PRIVATE), 'refusal never prints credential bytes');
  });
}
