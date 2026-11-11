/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/gate/index.js packages/sandbox/index.js */
/** Real detached fake-SSH jobs carry admitted policy into nested shards [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { mainPolicy } from '../../../../packages/sandbox/index.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { runnerPolicyRecord } from '../../../../packages/runners/index.js';
import { RUNNER_POLICY_FILE } from '../../../../packages/runners/index.js';
import { gitPath } from '../../../../packages/git/index.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { cleanupToolingSnapshots } from '../../tests/fixtures/runner/tooling.js';
import { cli } from '../../tests/fixtures/runner/tooling.js';
import { fixtureResultContext } from '../../tests/fixtures/runner/tooling.js';
import { git } from '../../tests/fixtures/runner/tooling.js';
import { gateResult } from '../../tests/fixtures/runner/tooling.js';
import { runThroughGate } from '../../tests/fixtures/runner/tooling.js';
import { committedToolingSnapshot } from '../../tests/fixtures/runner/tooling.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';

after(cleanupToolingSnapshots);

/** Create an isolated source tree whose coordinator policy is newer than its candidate. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-policy-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'primary');
  const home = join(dir, 'home');
  const machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'remote');
  const worker = join(dir, 'worker');
  const bin = join(dir, 'bin');
  const remoteMachine = join(remoteHome, '.pullboard');
  for (const folder of [repo, home, machineHome, remoteHome, remoteMachine, worker, bin]) mkdirSync(folder, { recursive: true });
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Policy Fixture', GIT_AUTHOR_EMAIL: 'policy@example.invalid',
    GIT_COMMITTER_NAME: 'Policy Fixture', GIT_COMMITTER_EMAIL: 'policy@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { runnersFirst: true } }));
  writeFileSync(join(remoteMachine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), repo);
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'candidate gate', landingShards: 2, protect: { allowed: ['*.example'] } }));
  writeFileSync(join(repo, '.env.example'), 'harmless allowed example\n');
  writeFileSync(join(repo, 'test/nested.test.js'), `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { mainPolicy } from '../packages/sandbox/index.js';
test('nested shard uses carried admitted policy [C7,V4]', () => {
  const policy = mainPolicy(process.cwd());
  assert.equal(policy.config.gate, 'admitted policy gate');
  const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
  assert.equal(policy.commit, git('rev-parse', 'main'));
  assert.notEqual(policy.commit, git('rev-parse', 'HEAD'));
  assert.equal(existsSync('.git/pullboard/board.sqlite'), false);
});\n`);
  git(repo, env, 'init', '-q', '-b', 'main');
  git(repo, env, 'add', '.');
  git(repo, env, 'commit', '-q', '-m', 'test: candidate source');
  const candidate = git(repo, env, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'admitted policy gate', landingShards: 2, protect: { allowed: ['.env.example'] } }));
  git(repo, env, 'add', 'pullboard.json');
  git(repo, env, 'commit', '-q', '-m', 'test: newer coordinator policy');
  const trunk = git(repo, env, 'rev-parse', 'HEAD');
  const source = join(dir, 'candidate');
  git(repo, env, 'worktree', 'add', '--detach', source, candidate);
  const requests = join(dir, 'requests.jsonl');
  const stderrLog = join(dir, 'worker.stderr');
  /** Read the original immutable request log; caller comparisons retain their exact raw bytes. */
  function readRequests() {
    return readFileSync(requests, 'utf8');
  }
  /** Preserve the existing conditional stderr read and its native missing-file failure. */
  function readStderr() {
    return readFileSync(stderrLog, 'utf8');
  }
  installSshStandIn({ bin, worker, home: remoteHome,
    machineHome: remoteMachine, requests, stderrLog });
  return { dir, repo, source, candidate, trunk, env, requests, stderrLog, readRequests, readStderr };
}

test('ordinary fake-SSH source carries its actual trunk policy into a detached nested shard without a board [C7,V4]', async t => {
  const box = fixture(t);
  const registered = cli(box.source, box.env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(registered.status, 0, registered.context);
  const result = await runThroughGate(box.source, box.env, 'node apps/cli/src/io/run/tests.js test/nested.test.js', { landing: true, requests: box.requests });
  assert.equal(result.status, 0, fixtureResultContext(result) + (existsSync(box.stderrLog) ? box.readStderr() : ''));
  assert.equal(gateResult(result.stdout).runner, HOST, 'the positive policy proof must execute remotely, never pass by local fallback');
  assert.match(result.stdout, /nested shard uses carried admitted policy/u);
  assert.match(result.stdout, /TAP version 13/u);
  assert.doesNotMatch(result.stdout, /NO_POLICY/u);
  assert.ok(existsSync(box.requests), 'the real worker ran through the fake SSH transport');
  const tooling = committedToolingSnapshot(resolve(import.meta.dirname, '../../../..'), box.env);
  const command = `node --input-type=module -e 'import {mainPolicy} from "./packages/sandbox/index.js"; console.log("PRIVATE_CARRIED_POLICY",mainPolicy(process.cwd()).commit)'`;
  const controller = `import { runOnRunnerAsync } from ${JSON.stringify(pathToFileURL(join(tooling, 'packages/runners/index.js')).href)};
const result = await runOnRunnerAsync(${JSON.stringify(box.source)}, ${JSON.stringify(command)}, {
 runner: { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 1 },
 metadata: { trunk: { ref: 'refs/heads/main', commit: ${JSON.stringify(box.candidate)} } },
 privateCheck: { kind: 'private-check', version: 1, install: '', check: ${JSON.stringify(command)}, timeoutMs: 30000,
  policyCommit: ${JSON.stringify(box.trunk)}, trunk: { ref: 'refs/heads/main', commit: ${JSON.stringify(box.trunk)} }, guard: null },
 checkedSource: { commit: ${JSON.stringify(box.candidate)}, tree: ${JSON.stringify(git(box.source, box.env, 'rev-parse', 'HEAD^{tree}'))} },
 rawOutputPath: ${JSON.stringify(join(box.dir, 'private.raw'))} });
console.log(JSON.stringify(result.privateCheck)); process.exitCode = result.isGreen ? 0 : 1;`;
  const reviewed = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', controller], { cwd: box.source, env: box.env });
  assert.equal(reviewed.status, 0, reviewed.context);
  assert.match(readFileSync(join(box.dir, 'private.raw'), 'utf8'), new RegExp(`PRIVATE_CARRIED_POLICY ${box.trunk}`, 'u'), 'the private envelope wins over a moved prequeue ordinary tuple');
  const missing = join(box.dir, 'missing-policy');
  git(box.repo, box.env, 'clone', '--no-local', '--no-checkout', box.repo, missing);
  git(missing, box.env, 'checkout', '--detach', box.candidate);
  const refused = await runThroughGate(missing, box.env, 'node apps/cli/src/io/run/tests.js test/nested.test.js', { landing: true, requests: box.requests });
  assert.equal(refused.status, 1, fixtureResultContext(refused));
  assert.match(refused.stdout, /NO_POLICY/u, 'a real nested job without carried provenance refuses loudly');
  const requestsBeforeProtection = box.readRequests();
  writeFileSync(join(box.repo, 'confidential.txt'), 'harmless protected history witness\n');
  git(box.repo, box.env, 'add', 'confidential.txt');
  git(box.repo, box.env, 'commit', '-q', '-m', 'test: historical protected path');
  git(box.repo, box.env, 'rm', 'confidential.txt');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ gate: 'admitted policy gate', protect: { blocked: ['confidential.txt'], allowed: ['.env.example'] } }));
  git(box.repo, box.env, 'add', 'pullboard.json');
  git(box.repo, box.env, 'commit', '-q', '-m', 'test: admitted policy blocks removed history');
  const protectedRun = await runThroughGate(box.source, box.env, 'node -e "console.log(1)"', { requests: box.requests });
  assert.equal(protectedRun.status, 1, fixtureResultContext(protectedRun));
  assert.match(protectedRun.stdout + protectedRun.stderr, /RUNNER_SECRET/u);
  assert.equal(box.readRequests(), requestsBeforeProtection, 'new admitted protection rules stop historical bytes before SSH');
});

test('detached nested policy refuses absent, malformed, stale-source and changed-trunk context [C7,V4]', t => {
  const box = fixture(t);
  const isolated = join(box.dir, 'isolated');
  git(box.repo, box.env, 'clone', '--no-local', '--no-checkout', box.repo, isolated);
  git(isolated, box.env, 'checkout', '--detach', box.candidate);
  const path = join(isolated, '.git', RUNNER_POLICY_FILE);
  writeFileSync(join(box.repo, '.git', RUNNER_POLICY_FILE), '{broken');
  assert.equal(mainPolicy(box.source).commit, box.trunk, 'a normal coordinator remains authoritative over any carried record');
  assert.throws(() => mainPolicy(isolated), error => error.code === 'NO_POLICY');
  writeFileSync(path, '{broken');
  assert.throws(() => mainPolicy(isolated), error => error.code === 'NO_POLICY');
  const record = runnerPolicyRecord({ id: 'fixture-job', commit: box.candidate,
    tree: git(isolated, box.env, 'rev-parse', 'HEAD^{tree}'), trunk: { ref: 'refs/heads/main', commit: box.trunk } });
  writeFileSync(gitPath(box.source, RUNNER_POLICY_FILE), JSON.stringify(record));
  git(box.repo, box.env, 'checkout', '--detach', box.trunk);
  assert.throws(() => mainPolicy(box.source), error => error.code === 'NO_POLICY', 'a linked worktree cannot override a detached coordinator with a copied record');
  git(box.repo, box.env, 'checkout', 'main');
  writeFileSync(path, JSON.stringify(record));
  assert.equal(mainPolicy(isolated).commit, box.trunk);
  git(isolated, box.env, 'checkout', '--detach', box.trunk);
  assert.throws(() => mainPolicy(isolated), error => error.code === 'NO_POLICY');
  git(isolated, box.env, 'checkout', '--detach', box.candidate);
  git(isolated, box.env, 'update-ref', 'refs/heads/main', box.candidate);
  assert.throws(() => mainPolicy(isolated), error => error.code === 'NO_POLICY');
  git(isolated, box.env, 'update-ref', 'refs/heads/main', box.trunk);
  const tampered = { ...record, tree: 'a'.repeat(40) };
  writeFileSync(path, JSON.stringify(tampered));
  assert.throws(() => mainPolicy(isolated), error => error.code === 'NO_POLICY');
  assert.notEqual(readFileSync(path, 'utf8'), JSON.stringify(record));
});
