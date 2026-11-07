/** @pullboard-test-input source-tree */
/**
 * A command pays only for its own modules and asks Git for repository facts once: the real CLI runs under a
 * module-load hook and a counting Git shim, so the count is what a person's terminal and the git hooks pay [C7].
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { assertStartupBudgets } from './cli-startup-budget-fixture.js';
import { fixtureJoin } from './testkit-fixture.js';

const REPO = resolve(import.meta.dirname, '..');
const BIN = join(REPO, 'bin', 'pullboard.js');
/** Modules a read must never load: the gate runner, the relay client and the landing machinery. */
const HEAVY = ['src/gate.js', 'src/land.js', 'apps/cli/src/shell/commands/gate.js', 'apps/cli/src/shell/commands/relay.js', 'src/commands/land.js',
  'packages/sandbox/src/shell/trusted-policy.js', 'packages/gate/src/shell/check-baseline.js', 'packages/gate/src/shell/shell-run.js', 'packages/commits/src/shell/hooks.js', 'packages/resources/index.js',
  'src/board.js', 'packages/store/src/shell/board-event-log.js', 'src/machine.js', 'src/sentinels.js', 'packages/sentinels/src/shell/sentinels.js', 'src/landing-lease.js', 'src/board-landing-lease.js'];

/** Find the real Git executable before the fixture puts its counting shim first on PATH. */
function realGitPath() {
  const found = process.env.PATH.split(delimiter).map((entry) => join(entry || '.', 'git')).find((candidate) => existsSync(candidate));
  assert.ok(found, 'the test environment has Git on PATH');
  return found;
}

/**
 * A module preloaded with --import that records every file module the process loads. Node 22.15 and newer take
 * in-thread hooks; 22.13 takes the off-thread loader, which writes the same log.
 */
function moduleHook(dir) {
  const loader = join(dir, 'module-loader.mjs');
  const record = `if (url.startsWith('file:')) appendFileSync(process.env.PULLBOARD_MODULE_LOG, url + '\\n');`;
  writeFileSync(loader, [
    "import { appendFileSync } from 'node:fs';",
    `export async function load(url, context, next) { ${record} return next(url, context); }`,
  ].join('\n'));
  const hook = join(dir, 'module-hook.mjs');
  writeFileSync(hook, [
    "import module from 'node:module';",
    "import { appendFileSync } from 'node:fs';",
    'if (module.registerHooks) {',
    `  module.registerHooks({ load(url, context, next) { ${record} return next(url, context); } });`,
    `} else module.register(${JSON.stringify(new URL(`file://${loader}`).href)});`,
  ].join('\n'));
  return hook;
}

/** A real coordinator repo with one item on its board, a counting Git shim and a module-load hook. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-startup-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const shims = join(dir, 'shims');
  const home = join(dir, 'home');
  const gitCallsFile = join(dir, 'git-calls.log');
  const moduleLogFile = join(dir, 'modules.log');
  mkdirSync(repo);
  mkdirSync(shims);
  // Each line names the folder Git ran in, then its arguments, so a count can tell this repository from the code's own.
  writeFileSync(join(shims, 'git'), '#!/bin/sh\nprintf "%s\\t%s\\n" "$(pwd -P)" "$*" >> "$PULLBOARD_GIT_CALLS"\nexec "$PULLBOARD_REAL_GIT" "$@"\n');
  chmodSync(join(shims, 'git'), 0o755);
  // The repository's git hooks run pullboard from PATH; they must run this checkout, not an installed release.
  writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`);
  chmodSync(join(shims, 'pullboard'), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PULLBOARD_HOME: join(home, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(home, '.pullboard-machine'),
    PULLBOARD_GIT_CALLS: gitCallsFile,
    PULLBOARD_MODULE_LOG: moduleLogFile,
    PULLBOARD_REAL_GIT: realGitPath(),
    PATH: `${shims}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  };
  for (const name of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_RELAY_KEY']) delete env[name];
  const hook = moduleHook(dir);
  /** Run the real CLI and return its result with the modules it loaded and the Git processes it started. */
  const runIn = (cwd, ...args) => {
    writeFileSync(gitCallsFile, '');
    writeFileSync(moduleLogFile, '');
    const result = runFixtureChild(process.execPath, ['--import', hook, BIN, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    const modules = [...new Set(readFileSync(moduleLogFile, 'utf8').split('\n').filter(Boolean))]
      .map((url) => fileURLToPath(url)).filter((path) => path.startsWith(REPO + sep)).map((path) => path.slice(REPO.length + 1).split(sep).join('/'));
    const gitCalls = readFileSync(gitCallsFile, 'utf8').split('\n').filter(Boolean);
    return { ...result, modules, gitCalls };
  };
  const run = (...args) => runIn(repo, ...args);
  const gitAt = (cwd, ...args) => assert.equal(runFixtureChild(env.PULLBOARD_REAL_GIT, args, { cwd, env, encoding: 'utf8' }).status, 0);
  const git = (...args) => gitAt(repo, ...args);
  /** Compare the command snapshot with uncached facts from the same real repository. */
  const facts = (cwd) => {
    writeFileSync(gitCallsFile, '');
    const source = `import {readFileSync} from 'node:fs';
import {repoInfo,headCommit,mainCheckout,withGitFacts} from ${JSON.stringify(new URL('../src/git.js', import.meta.url).href)};
const root=${JSON.stringify(cwd)};
const read=()=>({info:repoInfo(root),head:headCommit(root),primary:mainCheckout(root)});
const scoped=await withGitFacts(read);
const count=readFileSync(process.env.PULLBOARD_GIT_CALLS,'utf8').split('\\n').filter(Boolean).length;
const uncached=read();
console.log(JSON.stringify({scoped,uncached,count}));`;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
    const resultFacts = JSON.parse(result.stdout);
    assert.deepEqual(resultFacts.scoped, resultFacts.uncached, 'command memo keeps the original uncached Git contracts');
    return resultFacts;
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    spec: 'SPEC.md', practice: 'DOCTRINE.md', gate: 'true', lanes: { core: { owns: ['src/'], specs: ['C7'] } },
  }));
  writeFileSync(join(repo, 'SPEC.md'), '# Test spec\n\n## C · Core\n- C7 [approved, must] A command loads only its own modules. | gate: test/cli-startup.test.js\n');
  run('init');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore(repo): set up the startup fixture');
  run('add', 'core', 'Show me', '--specs', 'C7', '--criterion', 'it shows', '--brief', 'Files: src/a.js\nTest: it shows.');
  const worktree = join(dir, 'core-1');
  git('worktree', 'add', '-q', '-b', 'core/one', worktree);
  fixtureJoin(runIn, worktree, 'core', '--model', 'test-model');
  return { run, runIn, worktree, repo, gitAt, facts };
}

test('clause 1: show reads only its read store and list reads only its read store [C7]', async (t) => {
  const box = fixture(t);
  const version = box.run('--version');
  assert.match(version.stdout, /^\d+\.\d+\.\d+/u);
  assert.ok(version.modules.length <= 10, `--version loaded ${version.modules.length} repository modules: ${version.modules.join(', ')}`);
  assert.equal(version.gitCalls.length, 0, `--version started Git: ${version.gitCalls.join(' | ')}`);
  const show = box.run('show', '1');
  assert.match(show.stdout, /^#1 {2}/u);
  assert.deepEqual(show.modules.filter((path) => HEAVY.includes(path)), [], 'show loads no gate, relay or land module');
  const list = box.run('list', '--json');
  assert.equal(JSON.parse(list.stdout).items.length, 1);
  assert.deepEqual(list.modules.filter((path) => HEAVY.includes(path)), [], 'list loads no gate, relay or land module');
});

test('startup budget keeps fresh read medians under 100 ms [C7]', async (t) => {
  await assertStartupBudgets(t);
});
