/** First-run guidance on private Git repos, including unrelated files setup must not stage [I1,I2]. */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  runFixtureChild,
  runFixtureChildAsync,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
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
import {
  bindLocalSession,
  CHECKOUT_SESSION_TOKEN_ENV,
} from '../../../../packages/seats/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { repoInfo } from '../../../../packages/git/index.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';

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

test('verbose init exposes one confirmation command for its own writes [I1,I2,D1,D2]', async (t) => {
  const box = project(t);
  box.git('config', 'user.name', 'Newcomer Fixture');
  box.git('config', 'user.email', 'newcomer@example.invalid');
  const bin = join(box.root, 'fixture-bin');
  mkdirSync(bin);
  symlinkSync(BIN, join(bin, 'pullboard'));
  box.env.PATH = bin + ':' + process.env.PATH;
  writeFileSync(join(box.root, '.env.local'), 'LOCAL=1\n');
  writeFileSync(join(box.root, 'notes.txt'), 'keep this out of the initial commit\n');
  writeFileSync(join(box.root, '.gitignore'), '.claude/\n');
  mkdirSync(join(box.root, '.githooks'));
  writeFileSync(join(box.root, '.githooks', 'pre-commit'), '#!/bin/sh\n# My hook\n');
  mkdirSync(join(box.root, '.claude', 'skills', 'pullboard-run'), { recursive: true });
  writeFileSync(join(box.root, '.claude', 'skills', 'pullboard-run', 'SKILL.md'), '# My existing guide\n');
  writeFileSync(join(box.root, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(box.root, 'AGENTS.md'), '# My instructions\n');
  const result = await box.inProcess('init', '--verbose');
  assert.equal(result.status, 0, result.stderr);
  const label = "To commit Pullboard's files: ";
  const recipes = result.stdout.split('\n').filter(line => line.startsWith(label));
  assert.equal(recipes.length, 1, 'verbose exposes exactly one setup-only confirmation');
  const stagingLine = recipes[0];
  const command = stagingLine.slice(label.length);
  assert.equal(command, 'pullboard init --yes');
  const staged = spawnSync('sh', ['-c', command], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const committed = box.git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  for (const file of ['pullboard.json', 'SPEC.md', 'DOCTRINE.md', '.githooks/commit-msg']) assert.ok(committed.includes(file), file);
  for (const file of ['.env.local', 'notes.txt', '.githooks/pre-commit', '.claude/skills/pullboard-run/SKILL.md', 'fixture-bin/pullboard']) {
    assert.equal(committed.includes(file), false, `setup never commits the existing ${file}`);
  }
  assert.equal(box.git('diff', '--cached', '--name-only'), '', 'the setup-only commit leaves no extra staging behind');
  assert.equal(readFileSync(join(box.root, '.env.local'), 'utf8'), 'LOCAL=1\n');
  assert.equal(readFileSync(join(box.root, '.githooks', 'pre-commit'), 'utf8'), '#!/bin/sh\n# My hook\n');
  const head = box.git('rev-parse', 'HEAD');
  const rerun = await box.inProcess('init');
  assert.equal(rerun.status, 0, rerun.stderr);
  const secondStage = rerun.stdout.trimEnd().split('\n').at(-1);
  assert.doesNotMatch(secondStage, /pullboard init --yes/u, 'committed setup needs no second confirmation');
  assert.equal(box.git('rev-parse', 'HEAD'), head);
  assert.equal(box.git('diff', '--cached', '--name-only'), '');
});

test('an agent that runs init continues setup in the same session [I1,I2]', async (t) => {
  const human = project(t);
  for (const marker of AGENT_SHELL_MARKERS) delete human.env[marker];
  const humanResult = await human.inProcess('init');
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.ok(humanResult.stdout.includes('Next: ask your agent to run pullboard resume to finish setup.'));
  assert.doesNotMatch(humanResult.stdout, /run pullboard resume now/u);

  const agent = project(t);
  for (const marker of AGENT_SHELL_MARKERS) delete agent.env[marker];
  agent.env.CLAUDECODE = '1';
  const agentResult = await agent.inProcess('init');
  assert.equal(agentResult.status, 0, agentResult.stderr);
  assert.ok(agentResult.stdout.includes('Next: run pullboard resume to continue setup in this session.'));
  assert.doesNotMatch(agentResult.stdout, /Next: ask your agent/u);
  const humanDetails = await human.inProcess('init', '--verbose');
  assert.equal(humanDetails.status, 0, humanDetails.stderr);
  assert.match(humanDetails.stdout, /in Claude Code, start a new session first so it loads the Pullboard skills/u);
  const agentDetails = await agent.inProcess('init', '--verbose');
  assert.equal(agentDetails.status, 0, agentDetails.stderr);
  assert.match(agentDetails.stdout, /new skills load next session, and setup does not need them/u);
});

test('init detects language gates and gives an example in the same ecosystem [I1,I2]', async (t) => {
  const cases = [
    ['pyproject.toml', '[project]\nname = "example"\n', 'pytest'],
    ['pytest.ini', '', 'pytest'],
    ['setup.cfg', '[tool:pytest]\n', 'pytest'],
    ['go.mod', 'module example.test/project\n', 'go test ./...'],
    ['Cargo.toml', '[package]\nname = "example"\nversion = "0.1.0"\n', 'cargo test'],
    ['package.json', JSON.stringify({ scripts: { test: 'node --test' } }), 'npm test'],
  ];
  for (const [file, text, gate] of cases) {
    const box = project(t);
    writeFileSync(join(box.root, file), text);
    const result = await box.inProcess('init');
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')).gate, gate, file);
    assert.ok(readFileSync(join(box.root, 'SPEC.md'), 'utf8').includes(`| gate: ${gate}\n`), file);
    assert.doesNotMatch(result.stdout, /no gate yet/);
  }
  const mixed = project(t);
  writeFileSync(join(mixed.root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  writeFileSync(join(mixed.root, 'go.mod'), 'module example.test/project\n');
  assert.equal((await mixed.inProcess('init')).status, 0);
  assert.equal(JSON.parse(readFileSync(join(mixed.root, 'pullboard.json'), 'utf8')).gate, 'go test ./...');

  const emptyConfigured = project(t);
  writeFileSync(join(emptyConfigured.root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal((await emptyConfigured.inProcess('init')).status, 0);
  const configPath = join(emptyConfigured.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.gate = '';
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const rerun = await emptyConfigured.inProcess('init', '--verbose');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /no gate yet: record the command that proves the build with pullboard gate set 'npm test'/u);
  assert.doesNotMatch(rerun.stdout, /if this board has no build/u);
});

test('setup offers a gate to a board with no build [I1,I2]', async (t) => {
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

test('bare pullboard starts with the tour and init pointer; explicit help and JSON stay usable [I1,I2]', async (t) => {
  const box = project(t);
  const bare = await box.inProcess();
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout.split('\n')[0], 'New here? pullboard tour, then pullboard init.');
  assert.ok(bare.stdout.includes('pullboard next'));
  assert.ok(!(await box.inProcess('help')).stdout.startsWith('New here?'));
  const document = JSON.parse((await box.inProcess('--json')).stdout);
  assert.equal(typeof document.help, 'string');
  assert.ok(document.help.includes('pullboard init'));
});

/** A directory whose pullboard is this checkout's, so init's Git hooks run the code under test (#906). */
function checkoutPullboard(root) {
  const bin = join(root, '.this-pullboard');
  mkdirSync(bin);
  symlinkSync(BIN, join(bin, 'pullboard'));
  return bin;
}

test('init --yes commits its setup and exits in every agent session [I1,I2]', { timeout: 600_000 }, async (t) => { // budget: hang ceiling for eight inits, each about 2 s.
  for (const marker of AGENT_SHELL_MARKERS) {
    const box = project(t);
    for (const name of [...AGENT_SHELL_MARKERS, CHECKOUT_SESSION_TOKEN_ENV]) delete box.env[name];
    box.env[marker] = '1';
    Object.assign(box.env, { PATH: checkoutPullboard(box.root) + ':' + box.env.PATH, PULLBOARD_MACHINE_HOME: join(box.root, '.private-machine'), PULLBOARD_VIEW_BACKGROUND: '0' });
    box.git('config', 'user.name', 'Newcomer');
    box.git('config', 'user.email', 'newcomer@example.invalid');
    box.git('commit', '-q', '--allow-empty', '-m', 'initial');
    // 0.9.1 hung here for good: the pre-commit hook of init's own commit waited on init's checkout lease (#906).
    // process-level: a real process: 0.9.1 hung here, so the case is the process finishing.
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

test('a command started under a held checkout acts under it, and a hook that must wait names the holder and stops [I1,I2]', async (t) => {
  const box = project(t);
  box.git('config', 'user.name', 'Newcomer');
  box.git('config', 'user.email', 'newcomer@example.invalid');
  box.git('commit', '-q', '--allow-empty', '-m', 'initial');
  const info = repoInfo(box.root);
  const before = process.env[CHECKOUT_SESSION_TOKEN_ENV];
  delete process.env[CHECKOUT_SESSION_TOKEN_ENV];
  const holder = await bindLocalSession(info, { agent: 'holding-agent', digest: 'a'.repeat(64), keepLease: true });
  let takeover;
  try {
    // A child of the holding command (its env carries the lease) proceeds at once instead of queueing behind it.
    assert.ok(process.env[CHECKOUT_SESSION_TOKEN_ENV], 'the holding command passes its lease to what it starts');
    await bindLocalSession(info, { agent: 'holding-agent', digest: 'a'.repeat(64) });
    // A takeover holds the exclusive lease while it waits for the existing writer to drain.
    delete process.env[CHECKOUT_SESSION_TOKEN_ENV];
    takeover = bindLocalSession(info, { agent: 'taking-agent', digest: 'b'.repeat(64), takeover: true, recordTakeover: async () => {} });
    const intent = join(info.gitDir, 'pullboard-checkout-takeover');
    await waitForCondition(() => existsSync(intent), 'the takeover acquires its checkout lease', { signal: AbortSignal.timeout(10_000) }); // Budget: runaway ceiling for this fixture's takeover.
    assert.ok(existsSync(intent), 'the takeover holds the checkout while the writer is active');
    // A hook waiting behind that real holder gives up after its limit with the holder named.
    await assert.rejects(bindLocalSession(info, { agent: 'holding-agent', digest: 'a'.repeat(64), waitLimitMs: 300 }),
      (error) => error.code === 'CHECKOUT_BUSY' && /in use by taking-agent \(since /u.test(error.message) && /then commit again/u.test(error.message));
  } finally {
    holder.release();
    if (takeover) await takeover;
    if (before === undefined) delete process.env[CHECKOUT_SESSION_TOKEN_ENV];
    else process.env[CHECKOUT_SESSION_TOKEN_ENV] = before;
  }
});
