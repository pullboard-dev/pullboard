/** A real checkout lock proves runner setup diagnostics without changing an owner repository [C6,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { takeResource } from '../../../../../../packages/resources/index.js';
import {
  HOST,
  SECRET,
  installSshStandIn,
  shellQuote,
} from '../ssh.js';

/** Force Git's own checkout lock failure and require an actionable, path-free setup result. */
export async function sourceSetupFailureFixture(t, { cli, git, runThroughGate, gateResult }, mode = 'lock') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-setup-cause-')));
  let completed = false;
  t.after(() => {
    if (completed) rmSync(dir, { recursive: true, force: true });
    else t.diagnostic(`retained failed source-setup fixture at ${dir}`);
  });
  const home = join(dir, 'home'), machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'worker-home'), remoteMachineHome = join(remoteHome, '.pullboard');
  const configuredRoot = mode === 'custom-filesystem' ? join(dir, 'configured-root') : join(remoteHome, '.pullboard-runner');
  const repo = join(dir, 'repo'), worker = join(dir, 'worker'), bin = join(dir, 'bin');
  const requests = join(dir, 'requests.jsonl'), injected = join(dir, 'injected');
  const executed = join(dir, 'command-executed'), preload = join(dir, 'checkout-lock.mjs');
  for (const path of [home, machineHome, remoteHome, remoteMachineHome, repo, worker, bin]) mkdirSync(path, { recursive: true });
  // The stand-in runner is this host, so its load reading is the real runner's: two such files at once pushed it past
  // 1.5x cores and load-aware dispatch held every mode in dispatch. This fixture proves setup diagnostics, not load.
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, gate: { loadAwareDispatch: false } }));
  const env = { ...process.env, HOME: home, PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Setup Fixture', GIT_AUTHOR_EMAIL: 'setup@example.invalid',
    GIT_COMMITTER_NAME: 'Setup Fixture', GIT_COMMITTER_EMAIL: 'setup@example.invalid' };
  git(repo, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'source\n');
  git(repo, env, 'add', '.'); git(repo, env, 'commit', '-qm', 'test: source setup fixture');
  if (mode.endsWith('filesystem')) {
    const state = configuredRoot;
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'repos'), 'a file prevents creating the cache directory\n');
    writeFileSync(injected, 'cache directory obstacle injected\n');
  }
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (${JSON.stringify(mode)} === 'custom-filesystem') process.env.TMPDIR = ${JSON.stringify(join(remoteHome, 'shell-tmp'))};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const operation = ${JSON.stringify(mode)} === 'index' ? 'index-pack' : 'checkout';
  const scope = ${JSON.stringify(mode)} === 'index' ? ${JSON.stringify(join(remoteHome, '.pullboard-runner', 'repos') + '/')} : ${JSON.stringify(join(remoteHome, '.pullboard-runner', 'jobs') + '/')};
  if (command === 'git' && args[0] === operation && options.cwd.startsWith(scope)) {
    writeFileSync(${JSON.stringify(injected)}, 'checkout lock injected\\n');
    if (${JSON.stringify(mode)} === 'index') return spawn(command, [...args, '--fixture-invalid-option'], options);
    if (${JSON.stringify(mode)} === 'missing') return spawn(${JSON.stringify(join(dir, 'missing-git'))}, args, options);
    // Let queued pipe bytes drain before exit; an immediate exit can discard the fixture's diagnostic tail.
    if (${JSON.stringify(mode)} === 'large') return spawn(process.execPath, ['-e', ${JSON.stringify(`process.stderr.write('x'.repeat(20_000) + ${JSON.stringify(`\nfatal: fixture tail token=${SECRET} https://user:fake-password@fixture.invalid/repo?token=${SECRET} ${remoteHome}/private.txt 10.20.30.40\nAuthorization: Bearer fixture-bearer-secret\nCookie: session=fixture-cookie-secret\n`)}); process.exitCode = 23;`)}], options);
    writeFileSync(join(options.cwd, '.git', 'index.lock'), 'held by this fixture\\n');
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();\n`);
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests,
    nodeOptions: `--import=${pathToFileURL(preload).href}` });
  mkdirSync(join(remoteHome, 'shell-tmp'), { recursive: true });
  const rootArgs = mode === 'custom-filesystem' ? ['--root', configuredRoot] : [];
  const added = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', ...rootArgs, '--json');
  assert.equal(added.status, 0, added.context);
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = home; process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo, agent: 'setup-holder' });
    const command = `node -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(executed)}, 'ran')`)}`;
    const result = await runThroughGate(repo, env, command, { requests });
    assert.equal(gateResult(result.stdout).isGreen, false, 'the failed setup is not a successful run');
    assert.equal(existsSync(injected), true, 'the real checkout Git operation encountered the lock');
    assert.equal(existsSync(executed), false, 'the requested command never ran or fell back locally');
    if (mode.endsWith('filesystem')) {
      assert.match(result.stdout, /step: source history checkout.*EEXIST[\s\S]*cause:/u, 'filesystem setup keeps its phase, code and cause');
    } else if (mode === 'index') {
      assert.match(result.stdout, /source cache: git index-pack.*exit \d+[\s\S]*git stderr:.*(?:usage|error)/iu, 'a broken pack command retains Git stderr even when its input pipe fails');
    } else assert.match(result.stdout, /git checkout/iu, 'the refusal names the failed Git step');
    if (mode === 'lock') assert.match(result.stdout, /index\.lock.*File exists/isu, 'the refusal retains Git’s concrete lock cause');
    if (mode === 'missing') assert.match(result.stdout, /ENOENT/u, 'a spawn failure keeps its code instead of an undefined exit');
    if (mode === 'large') {
      assert.match(result.stdout, /exit 23[\s\S]*fixture tail/u, 'bounded stderr retains the concrete failure tail');
      assert.ok(!result.stdout.includes(SECRET) && !result.stdout.includes('fake-password'), 'credential assignments and URL credentials stay private');
      assert.ok(!result.stdout.includes('fixture-bearer-secret') && !result.stdout.includes('fixture-cookie-secret'), 'spaced bearer and cookie credentials stay private');
      assert.ok(!result.stdout.includes('10.20.30.40'), 'private network addresses stay private');
      assert.ok(Buffer.byteLength(result.stdout.split('PULLBOARD_RUN_RESULT ')[0]) < 2_400, 'the diagnostic is bounded in bytes');
    }
    assert.ok(!result.stdout.includes(remoteHome), 'runner-private paths never reach the controller');
    assert.ok(!result.stdout.includes(configuredRoot), 'a configured runner root outside HOME and TMPDIR stays private too');
    completed = true;
  } finally {
    held?.release();
    for (const [index, key] of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
}
