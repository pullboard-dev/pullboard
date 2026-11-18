/** First-run setup offers a gate and commits its setup [I1,I2]. */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureChildAsync,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { CHECKOUT_SESSION_TOKEN_ENV } from '../../../../packages/seats/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
/** Run setup in an isolated repository, without invoking any installed test tools. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-newcomer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PULLBOARD_HOME: join(root, '.private-home') };
  /** Read a private Git command's result without inheriting the maintainer's configuration. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  /** Preserve CLI output so guidance is checked exactly as a newcomer receives it. */
  const run = (...args) => runCliInProcess(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  return { root, env, git, inProcess: run };
}

test('cli.journeys-gate-newcomer-setup.setup-offers-a-gate-to-a: clause 1: setup offers a gate to a board with no build [I1,I2]', async (t) => {
  const box = project(t);
  const initialized = await box.inProcess('init', '--verbose');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /if this board has no build.*pullboard spec check.*second agent review checks the actual work/u);

  const fixtureBin = join(box.root, 'fixture-bin');
  mkdirSync(fixtureBin);
  symlinkSync(BIN, join(fixtureBin, 'pullboard'));
  box.env.PATH = `${fixtureBin}:${process.env.PATH}`;
  const specCheck = runFixtureChild('pullboard', ['spec', 'check'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(specCheck.status, 0, specCheck.failure ?? specCheck.stderr);

  const configPath = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lanes.app = { owns: ['app/'] };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const specPath = join(box.root, 'SPEC.md');
  writeFileSync(specPath, `${readFileSync(specPath, 'utf8')}- G1 [approved, must] The board can check its own requirements. | gate: pullboard spec check\n`);

  const before = JSON.parse((await box.inProcess('resume', '--diagnostics', '--json')).stdout);
  assert.equal(before.setup.step, 3);
  assert.match(before.setup.question, /if this board has no build.*pullboard spec check.*second agent review checks the actual work/u);
  assert.match(before.setup.question, /choose a custom gate command/u);
  assert.match(before.setup.command, /pullboard spec check/u);
  const answer = runFixtureChild('sh', ['-c', before.setup.command], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(answer.status, 0, answer.failure ?? answer.stderr);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).gate, 'pullboard spec check');
  assert.equal(JSON.parse((await box.inProcess('resume', '--diagnostics', '--json')).stdout).setup.step, 4);

  box.git('add', '-f', '--', 'pullboard.json', 'SPEC.md', 'DOCTRINE.md', 'AGENTS.md', '.gitignore', '.githooks', '.claude');
  const stagedPaths = box.git('diff', '--cached', '--name-only').split('\n');
  assert.ok(stagedPaths.length > 0);
  const allowedSetupFiles = new Set(['pullboard.json', 'SPEC.md', 'DOCTRINE.md', 'AGENTS.md', '.gitignore']);
  assert.ok(stagedPaths.every(path => allowedSetupFiles.has(path) || path.startsWith('.githooks/') || path.startsWith('.claude/')), stagedPaths.join('\n'));
  box.git('-c', 'user.name=Pullboard fixture', '-c', 'user.email=pullboard-fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'chore: initialize Pullboard fixture');

  // The real gate reads committed main policy; commit only the setup paths created above first.
  box.env.PULLBOARD_MACHINE_HOME = join(box.root, '.private-machine-home');
  const gate = await box.inProcess('gate');
  assert.equal(gate.status, 0, gate.failure ?? gate.stderr);
});

/** A directory whose pullboard is this checkout's, so init's Git hooks run the code under test (#906). */
function checkoutPullboard(root) {
  const bin = join(root, '.this-pullboard');
  mkdirSync(bin);
  symlinkSync(BIN, join(bin, 'pullboard'));
  return bin;
}

test('cli.journeys-gate-newcomer-setup.init-yes-commits-its-setup-and: clause 2: init --yes commits its setup and exits in every agent session [I1,I2]', { timeout: 600_000 }, async (t) => { // budget: hang ceiling for eight inits, each about 2 s.
  for (const marker of AGENT_SHELL_MARKERS) {
    const box = project(t);
    for (const name of [...AGENT_SHELL_MARKERS, CHECKOUT_SESSION_TOKEN_ENV]) delete box.env[name];
    box.env[marker] = '1';
    Object.assign(box.env, { PATH: checkoutPullboard(box.root) + ':' + box.env.PATH, PULLBOARD_MACHINE_HOME: join(box.root, '.private-machine'), PULLBOARD_VIEW_BACKGROUND: '0' });
    box.git('config', 'user.name', 'Newcomer');
    box.git('config', 'user.email', 'newcomer@example.invalid');
    box.git('commit', '-q', '--allow-empty', '-m', 'initial');
    // 0.9.1 hung here for good: the pre-commit hook of init's own commit waited on init's checkout lease (#906).
    // process-level: 0.9.1 hung here, so the case is the process finishing.
    const running = runFixtureChildAsync(process.execPath, [BIN, 'init', '--yes', '--model', 'Test Model'], { cwd: box.root, env: box.env, detached: true });
    let timer;
    const result = await Promise.race([running, new Promise((done) => { timer = setTimeout(() => done(null), 60_000); })]); // budget: hang ceiling; init --yes takes about 2 s.
    clearTimeout(timer);
    if (!result) { try { process.kill(-running.child.pid, 'SIGKILL'); } catch { /* the group already ended */ } }
    assert.ok(result, `init --yes with ${marker} set never exited`);
    assert.equal(result.status, 0, result.context);
    assert.equal(String(box.git('log', '--format=%s', '-1')).trim(), 'chore: set up Pullboard', `${marker}: init committed its setup`);
  }
});
