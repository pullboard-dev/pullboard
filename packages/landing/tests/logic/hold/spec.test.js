/** @pullboard-test-input source-tree */
/** Real private worker/controller custody: refused input must not retain an open pipe or gate lease [C7]. */
import { executionServicesSource } from '../../../../../apps/cli/tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  startFixtureChild,
  runFixtureChildAsync,
  runFixtureGit,
} from '../../../../../apps/cli/tests/fixtures/child.js';
import {
  HOST,
  installSshStandIn,
} from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';

/** A fresh private environment has its own machine pool and no authority over existing workers. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-invalid-spec-'));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { PATH: `${paths.bin}:${process.env.PATH}`, HOME: paths.home,
    PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Invalid spec fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Invalid spec fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  return { directory, ...paths, env };
}

/** Wait only for this fixture-owned child; a hang fails and is cleaned up through its actual handle. */
async function closedWithin(child, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolveClose, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolveClose({ code, signal }));
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('owned worker did not exit after refusing its spec')), milliseconds); }),
    ]);
  } finally { clearTimeout(timeout); }
}

test('invalid framed specs exit promptly with a named refusal while controller stdin stays open [C7]', { timeout: 20000 }, async t => { // budget: three real worker startups and five-second refusal bounds, not a performance benchmark.
  const f = fixture(t);
  for (const input of ['2\n{}', 'not-a-frame\n', '1\n{']) {
    const worker = startFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../../../apps/runner/src/io/scripts/worker.js')], {
      cwd: f.repo, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });
    try {
      worker.stdin.on('error', () => {}); // A prompt refusal may close its pipe before this fixture's pending write settles.
      const ended = closedWithin(worker, 5000); // budget: a refused input has no setup or command work to wait for.
      worker.stdin.write(input); // Deliberately never end stdin: this is the original hang boundary.
      const result = await ended;
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(stderr, /^PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification$/mu);
      assert.equal(stdout, '');
      assert.equal(stderr.includes('PULLBOARD_RUNNER_RESULT'), false, 'invalid input cannot produce an execution receipt');
      assert.equal(stderr.includes('not-a-frame'), false, 'untrusted input is never echoed');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const ended = new Promise(resolveClose => worker.once('close', resolveClose));
        worker.kill('SIGKILL'); // Only this fixture's own handle, after its bounded failure.
        await ended;
      }
      worker.stdin.destroy();
    }
  }
});

/** Exercise the real controller with either malformed structure or a generated capacity contradiction. */
async function controllerCase(t, { invalidSpec, browser }) {
  const f = fixture(t);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: f.repo, env: f.env });
  writeFileSync(join(f.repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(f.repo, 'tracked.txt'), 'private source\n');
  runFixtureGit(['add', '-A'], { cwd: f.repo, env: f.env });
  runFixtureGit(['commit', '-qm', 'test: private runner source'], { cwd: f.repo, env: f.env });
  writeFileSync(join(f.machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1 }));
  const requests = join(f.directory, 'requests.jsonl');
  installSshStandIn({ bin: f.bin, worker: f.worker, home: f.remoteHome, machineHome: f.remoteMachine,
    requests, invalidSpec });
  const FRONT_DOORS = { 'gate.js': 'packages/gate/index.js', 'runners.js': 'packages/runners/index.js', 'resources.js': 'packages/resources/index.js' };
  const moduleURL = name => pathToFileURL(resolve(import.meta.dirname, '../../../../..', FRONT_DOORS[name])).href;
  const script = `
    import assert from 'node:assert/strict';
    import { withGateSlot } from ${JSON.stringify(moduleURL('gate.js'))};
${executionServicesSource(moduleURL('gate.js'))}
    import { runOnRunnerAsync } from ${JSON.stringify(moduleURL('runners.js'))};
    import { listResources, takeResource } from ${JSON.stringify(moduleURL('resources.js'))};
    const root = ${JSON.stringify(f.repo)};
    let refusal;
    try {
      await withGateSlot(root, async () => {
        const held = listResources({ root }).find(row => row.name === 'gate');
        assert.equal(held.holders.length, 1, 'the controller actually holds a private gate slot');
        await runOnRunnerAsync(root, 'printf must-not-run', { browser: ${browser}, runner: { host: ${JSON.stringify(HOST)}, slots: 1, browser: 0 } });
      }, { executionServices, remote: false, browser: false, gui: false, diagnostic: true, shortEligible: false,
        agent: 'private-invalid-spec-controller', kind: 'test' });
    } catch (error) { refusal = error; }
    assert.equal(refusal?.code, 'RUNNER_WORK_SPEC');
    assert.match(refusal.message, /invalid work specification/);
    assert.notEqual(refusal.runnerAttempt.exitCode, 0);
    assert.equal(refusal.runnerAttempt.output, '');
    assert.equal(listResources({ root }).find(row => row.name === 'gate').holders.length, 0);
    const next = await takeResource({ name: 'gate', capacity: 1, root, agent: 'next-private-controller' });
    assert.ok(next.token, 'another real admission can use the released slot');
    next.release();
    process.stdout.write(JSON.stringify({ failed: true, reason: refusal.code, slotFree: true }));
  `;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 20000, // budget: refusal plus source-capsule construction, without running a test command.
  });
  assert.equal(result.status, 0, result.stderr || result.failure);
  assert.deepEqual(JSON.parse(result.stdout), { failed: true, reason: 'RUNNER_WORK_SPEC', slotFree: true });
  const calls = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 1, 'a named refusal is not automatically requeued');
  assert.equal(calls[0].code, 1, 'the actual worker exited nonzero before the SSH stand-in returned');
  // The identical production transport still accepts a valid spec and returns its ordinary receipt.
  installSshStandIn({ bin: f.bin, worker: f.worker, home: f.remoteHome, machineHome: f.remoteMachine, requests });
  const valid = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import { runOnRunnerAsync } from ${JSON.stringify(moduleURL('runners.js'))};
    const result = await runOnRunnerAsync(${JSON.stringify(f.repo)}, 'printf valid-work', { runner: { host: ${JSON.stringify(HOST)}, slots: 1, browser: 0 } });
    process.stdout.write(JSON.stringify({ code: result.exitCode, output: result.output }));
  `], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 20000 }); // budget: unchanged small real source setup and one trivial valid command.
  assert.equal(valid.status, 0, valid.stderr || valid.failure);
  assert.deepEqual(JSON.parse(valid.stdout), { code: 0, output: 'valid-work' });
}

test('the controller reports an invalid-spec failure once and releases its real private gate slot [C7]', { timeout: 45000 }, async t => { // budget: real Git/capsule setup, one refusal and one valid private runner control.
  await controllerCase(t, { invalidSpec: true, browser: false });
});

test('a generated browser-required spec with zero capacity refuses before setup and releases the slot [C7]', { timeout: 45000 }, async t => { // budget: real source/capsule setup and a valid control following the bounded capacity refusal.
  await controllerCase(t, { invalidSpec: false, browser: true });
});
