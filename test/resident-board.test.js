/** @pullboard-test-input source-tree */
/**
 * Board commands run in a resident board process and the pullboard CLI is a thin client [H24]. The fixture copies
 * this checkout's code into its own Git checkout, so a commit there is "main's code changing", and runs the real CLI
 * against a real board in a separate repository.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  dirname,
  join,
  resolve,
} from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  after,
  before,
  test,
} from 'node:test';
import {
  runFixtureChild,
  runFixtureGit,
} from './fixture-child.js';
import { residentSocket } from '../bin/resident-client.js';

const REPO = resolve(import.meta.dirname, '..');
const BUDGET_MS = 200;
let fx;

/** Copy this checkout's code, untracked new files included, into a fresh checkout with one commit. */
function copyCode(code, env) {
  const files = runFixtureGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, env }).split('\0')
    .filter(file => file && !file.startsWith('test/') && existsSync(join(REPO, file)));
  for (const file of files) {
    mkdirSync(dirname(join(code, file)), { recursive: true });
    cpSync(join(REPO, file), join(code, file));
  }
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: code, env });
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'code one'], { cwd: code, env });
}

/** A module preloaded with --import that records every module, file or built-in, the process loads. */
function moduleHook(dir) {
  const hook = join(dir, 'module-hook.mjs');
  const loader = join(dir, 'module-loader.mjs');
  const record = 'appendFileSync(process.env.RESIDENT_MODULE_LOG, url + "\\n");';
  writeFileSync(loader, `import { appendFileSync } from 'node:fs';\nexport async function load(url, context, next) { ${record} return next(url, context); }\n`);
  writeFileSync(hook, ["import module from 'node:module';", "import { appendFileSync } from 'node:fs';",
    `if (module.registerHooks) module.registerHooks({ load(url, context, next) { ${record} return next(url, context); } });`,
    `else module.register(${JSON.stringify(new URL(`file://${loader}`).href)});`].join('\n'));
  return hook;
}

before(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pb-resident-')));
  const code = join(dir, 'code'), repo = join(dir, 'repo'), shims = join(dir, 'shims'), home = join(dir, 'home');
  const bin = join(code, 'bin', 'pullboard.js');
  mkdirSync(repo);
  mkdirSync(shims);
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, '.pullboard-machine'),
    PATH: `${shims}${delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
    PULLBOARD_RESIDENT: '1', PULLBOARD_RESIDENT_IDLE_MS: '120000', RESIDENT_MODULE_LOG: join(dir, 'modules.log') };
  for (const name of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_RELAY_KEY']) delete env[name];
  copyCode(code, env);
  // The board's git hooks run pullboard from PATH; they must run the copied code.
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec '${process.execPath}' '${bin}' "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const hook = moduleHook(dir);
  /** Run the copied CLI in a folder and return its output, exit code and wall time. */
  const runIn = (cwd, args, { modules = false } = {}) => {
    if (modules) writeFileSync(env.RESIDENT_MODULE_LOG, '');
    const started = performance.now();
    const result = runFixtureChild(process.execPath, [...(modules ? ['--import', hook] : []), bin, ...args], { cwd, env, encoding: 'utf8' });
    const ms = performance.now() - started;
    const loaded = modules ? [...new Set(readFileSync(env.RESIDENT_MODULE_LOG, 'utf8').split('\n').filter(Boolean))] : null;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms, loaded };
  };
  /** The resident process's pid, from the pid file it writes once it listens; null when none is running. */
  const residentPid = () => {
    const place = residentSocket(repo, bin);
    try { return Number(readFileSync(place.pid, 'utf8').trim()); } catch { return null; }
  };
  /** Whether a process is alive. */
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /**
   * Run version until the resident process answers it, which a thin client shows by loading under 20 modules.
   * Each try is a real command, so the wait ends on the observable answer rather than on a timer.
   */
  const awaitResident = () => {
    const deadline = performance.now() + 20_000;
    let last;
    while (performance.now() < deadline) {
      last = runIn(repo, ['version'], { modules: true });
      if (last.status === 0 && last.loaded.length < 20 && residentPid()) return last;
    }
    assert.fail(`no resident process answered within 20 s; last client loaded ${last?.loaded.length} modules`);
  };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo, env });
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ spec: 'SPEC.md', practice: 'DOCTRINE.md', gate: 'true',
    lanes: { core: { owns: ['src/'], specs: ['H24'] } } }));
  writeFileSync(join(repo, 'SPEC.md'), '# Test spec\n\n## H · Speed\n- H24 [approved, must] Board commands answer fast. | gate: test/resident-board.test.js\n');
  assert.equal(runIn(repo, ['init']).status, 0);
  runFixtureGit(['add', '-A'], { cwd: repo, env });
  runFixtureGit(['commit', '-q', '-m', 'chore(repo): set up the resident fixture'], { cwd: repo, env });
  for (const title of ['First', 'Second']) {
    const added = runIn(repo, ['add', 'core', title, '--specs', 'H24', '--criterion', 'it works', '--brief', 'Files: src/a.js\nTest: it works.']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
  }
  const worktree = join(dir, 'core-1');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'core/one', worktree], { cwd: repo, env });
  const joined = runIn(worktree, ['join', 'core', '--model', 'test-model']);
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  fx = { dir, code, repo, worktree, env, runIn, residentPid, alive, awaitResident };
});

after(() => {
  if (!fx) return;
  const pid = fx.residentPid();
  if (pid && fx.alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(fx.dir, { recursive: true, force: true });
});

/** The median wall time of three runs of one command, each checked for success. */
function median(cwd, args) {
  const times = [0, 1, 2].map(() => {
    const result = fx.runIn(cwd, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return result.ms;
  }).sort((a, b) => a - b);
  return times[1];
}

test('show, inbox, claim and next run through a warm resident process in under 200 ms, from a client of under 20 modules [H24]', () => {
  fx.awaitResident();
  for (const [cwd, args] of [[fx.repo, ['show', '1']], [fx.worktree, ['inbox']], [fx.worktree, ['claim', '1']], [fx.worktree, ['next']]]) {
    // One untimed run loads anything the process has not loaded yet; the client must stay thin on it.
    const warm = fx.runIn(cwd, args, { modules: true });
    assert.equal(warm.status, 0, `${args.join(' ')}: ${warm.stdout}${warm.stderr}`);
    assert.ok(warm.loaded.length < 20, `${args.join(' ')} loaded ${warm.loaded.length} modules in the client: ${warm.loaded.join(', ')}`);
    const ms = median(cwd, args);
    assert.ok(ms < BUDGET_MS, `${args.join(' ')} took a median ${Math.round(ms)} ms through the warm resident process`); // budget: approved row H24 bar, every warm board command under 200 ms
  }
  const shown = fx.runIn(fx.repo, ['show', '1']);
  assert.match(shown.stdout, /#1 {2}claimed core-1/u, 'the claim made through the resident process is on the board');
});

test('a killed resident process falls back in-process with the same output, and a new one starts [H24]', () => {
  fx.awaitResident();
  const warm = fx.runIn(fx.repo, ['show', '2', '--json'], { modules: true });
  assert.ok(warm.loaded.length < 20, 'the warm answer came from the resident process');
  const killed = fx.residentPid();
  process.kill(killed, 'SIGKILL');
  const fallback = fx.runIn(fx.repo, ['show', '2', '--json'], { modules: true });
  assert.ok(fallback.loaded.length > 100, `the fallback ran in-process, loading ${fallback.loaded.length} modules`);
  assert.deepEqual([fallback.status, fallback.stdout, fallback.stderr], [warm.status, warm.stdout, warm.stderr]);
  fx.awaitResident();
  assert.notEqual(fx.residentPid(), killed, 'the fallback started a fresh resident process');
});

test('a new main commit makes the next command use the new code [H24]', () => {
  fx.awaitResident();
  const before = fx.runIn(fx.repo, ['version']);
  const old = fx.residentPid();
  const packageFile = join(fx.code, 'package.json');
  const data = JSON.parse(readFileSync(packageFile, 'utf8'));
  data.version = '0.0.0-resident-new';
  writeFileSync(packageFile, JSON.stringify(data, null, 2) + '\n');
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'code two'], { cwd: fx.code, env: fx.env });
  const next = fx.runIn(fx.repo, ['version']);
  const release = (result) => result.stdout.split('\n')[0];
  assert.notEqual(release(before), '0.0.0-resident-new');
  assert.equal(release(next), '0.0.0-resident-new', 'the first command after the commit runs the new code');
  const warm = fx.awaitResident();
  assert.equal(release(warm), '0.0.0-resident-new', 'the new resident process serves the new code');
  assert.notEqual(fx.residentPid(), old);
  assert.equal(fx.alive(old), false, 'the resident process loaded from the old commit has retired');
});
