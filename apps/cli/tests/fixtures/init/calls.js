/** Shared fixture for the Git-call journeys: a private real repo, a linked worker and a counting Git shim [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
  resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stopFixtureLocalRunner } from '../runner/local-stop.js';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild,
} from '../child.js';
import { runCliInProcess } from '../process.js';

export const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
export const GIT_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/git/index.js')).href;

/** Find the real Git executable before the fixture adds its counting shim to PATH. */
function realGitPath() {
  const path = process.env.PATH.split(delimiter).map((entry) => join(entry || '.', 'git'));
  const found = path.find((candidate) => existsSync(candidate));
  assert.ok(found, 'the test environment has Git on PATH');
  return found;
}

/** Build a private real repo and linked agent worktree with an instrumented Git executable. */
export async function fixture(t, { ruleProof = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-git-calls-'));
  t.after(() => {
    stopFixtureLocalRunner(join(dir, 'home', '.pullboard-machine')); // a pulled gate starts the loopback runner, which heartbeats into the fixture [C7]
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); // a submitted run may still be writing [C7]
  });
  const repo = join(dir, 'repo');
  const worker = join(dir, 'worker');
  const home = join(dir, 'home');
  const shims = join(dir, 'shims');
  const calls = join(dir, 'git-calls.log');
  /** Read the same immutable per-fixture log path without changing reset or failure semantics. */
  function readCalls() {
    return readFileSync(calls, 'utf8');
  }
  mkdirSync(repo);
  mkdirSync(shims);
  const realGit = realGitPath();
  const gitShim = join(shims, 'git');
  const pullboardShim = join(shims, 'pullboard');
  writeFileSync(gitShim, '#!/bin/sh\nprintf "git %s\\n" "$*" >> "$PULLBOARD_GIT_CALLS"\nexec "$PULLBOARD_REAL_GIT" "$@"\n');
  chmodSync(gitShim, 0o755);
  writeFileSync(pullboardShim, `#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`);
  chmodSync(pullboardShim, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PULLBOARD_HOME: join(home, '.pullboard'),
    PULLBOARD_MACHINE_HOME: join(home, '.pullboard-machine'),
    PULLBOARD_GIT_CALLS: calls,
    PULLBOARD_REAL_GIT: realGit,
    PATH: `${shims}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.com',
  };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({
    spec: 'SPEC.md', practice: 'DOCTRINE.md', gate: ruleProof ? 'node --test test/proven.test.js' : 'true',
    lanes: { core: { owns: ['src/'], specs: ['C7'] } },
    submit: { handoff: false }, // no detached gate worker keeps writing into the fixture while it is removed [C7]
  }));
  writeFileSync(join(repo, 'SPEC.md'), '# Test spec\n\n## C · Core\n- C7 [approved, must] A command reads each Git fact once. | gate: apps/cli/journeys/init/calls.test.js\n');
  if (ruleProof) {
    // Establish this private board's approved rows before init records their original approval baseline.
    writeFileSync(join(repo, 'SPEC.md'), '# Rule budget fixture\n\n## C · Core\n' +
      '- C7 [approved, must] Current trunk proof stays cheap to read. | gate: test/proven.test.js\n' +
      '- C8 [approved, must] Recent red remains visible. | gate: test/red.test.js\n');
    mkdirSync(join(repo, 'test'));
    for (const name of ['proven', 'red']) writeFileSync(join(repo, `test/${name}.test.js`),
      `import { test } from 'node:test';\ntest('${name}', () => {});\n`);
  }
  const git = (cwd, ...args) => {
    const result = runFixtureChild(realGit, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) throw new Error(result.failure);
    return result.stdout.trim();
  };
  const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  const ok = (cwd, ...args) => {
    const result = run(cwd, ...args);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return result;
  };
  /** Run one setup command through production dispatch in this process; the measured commands stay real children [C7]. */
  const setup = async (cwd, ...args) => {
    const result = await runCliInProcess(args, { cwd, env });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  };
  git(repo, 'init', '-q', '-b', 'main');
  await setup(repo, 'init');
  // Git plumbing, which runs no hook: this commit is setup, and the pre-commit and commit-msg hooks each launched a Node child (#8362).
  git(repo, 'add', '-A');
  git(repo, 'update-ref', 'HEAD', git(repo, 'commit-tree', git(repo, 'write-tree'), '-m', 'chore(repo): initialize Git-call fixture'));
  git(repo, 'worktree', 'add', '-q', '-b', 'core/worker', worker);
  await setup(worker, 'join', 'core', '--route', 'light', '--family', 'codex');
  return { dir, repo, worker, calls, readCalls, env, git, run, ok };
}

/** Advance the fixture branch using real Git plumbing without running its checkout hooks. */
export function advanceHead(box, label, branch = 'main') {
  const parent = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const commit = execFileSync(box.env.PULLBOARD_REAL_GIT, ['commit-tree', tree, '-p', parent], {
    cwd: box.repo, env: box.env, input: label, encoding: 'utf8',
  }).trim();
  box.git(box.repo, 'update-ref', `refs/heads/${branch}`, commit);
  return commit;
}
