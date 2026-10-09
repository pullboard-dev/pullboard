/** Count real Git child processes and prove command-scoped facts refresh after a commit [C7]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { headCommit, withGitFacts } from '../src/git.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');

/** Find the real Git executable before the fixture adds its counting shim to PATH. */
function realGitPath() {
  const path = process.env.PATH.split(delimiter).map((entry) => join(entry || '.', 'git'));
  const found = path.find((candidate) => existsSync(candidate));
  assert.ok(found, 'the test environment has Git on PATH');
  return found;
}

/** Build a private real repo and linked agent worktree with an instrumented Git executable. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-git-calls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const worker = join(dir, 'worker');
  const home = join(dir, 'home');
  const shims = join(dir, 'shims');
  const calls = join(dir, 'git-calls.log');
  mkdirSync(repo);
  mkdirSync(shims);
  const realGit = realGitPath();
  const gitShim = join(shims, 'git');
  const pullboardShim = join(shims, 'pullboard');
  writeFileSync(gitShim, '#!/bin/sh\nprintf "git\\n" >> "$PULLBOARD_GIT_CALLS"\nexec "$PULLBOARD_REAL_GIT" "$@"\n');
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
    spec: 'SPEC.md', practice: 'DOCTRINE.md', gate: 'true',
    lanes: { core: { owns: ['src/'], specs: ['C7'] } },
  }));
  writeFileSync(join(repo, 'SPEC.md'), '# Test spec\n\n## C · Core\n- C7 [approved, must] A command reads each Git fact once. | gate: test/git-calls.test.js\n');
  const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  const ok = (cwd, ...args) => {
    const result = run(cwd, ...args);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return result;
  };
  git(repo, 'init', '-q', '-b', 'main');
  ok(repo, 'init');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore(repo): initialize Git-call fixture');
  git(repo, 'worktree', 'add', '-q', '-b', 'core/worker', worker);
  ok(worker, 'join', 'core', '--route', 'light', '--family', 'codex');
  return { dir, repo, worker, calls, env, git, run, ok };
}

/** Clear the per-command count and read the number of Git processes the CLI started. */
function resetAndCount(box, cwd, ...args) {
  writeFileSync(box.calls, '');
  const result = box.run(cwd, ...args);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const count = readFileSync(box.calls, 'utf8').trim().split('\n').filter(Boolean).length;
  return { result, count };
}

test('help starts no Git and linked-worktree status spawns at most four Git processes [C7]', (t) => {
  const box = fixture(t);
  const version = resetAndCount(box, box.dir, '--version');
  assert.equal(version.count, 0, '--version has no repository work to do');
  const help = resetAndCount(box, box.dir, 'help');
  assert.equal(help.count, 0, 'global help has no repository work to do');
  const status = resetAndCount(box, box.worker, 'status', '--json');
  assert.ok(status.count <= 4, `linked-worktree status started ${status.count} Git processes`);
  assert.equal(JSON.parse(status.result.stdout).me.id, 'core-1');
});

test('a runner sees the new HEAD after it commits its item [C7]', (t) => {
  const box = fixture(t);
  box.ok(box.repo, 'add', 'core', 'Refresh cached HEAD', '--specs', 'C7', '--route', 'light',
    '--criterion', 'the runner reads the commit it just made', '--check', 'test -f src/result.txt',
    '--brief', 'Files: src/result.txt\nTest: the runner creates the result file.');
  const agent = join(box.dir, 'agent.sh');
  writeFileSync(agent, '#!/bin/sh\nmkdir -p src\nprintf result > src/result.txt\n');
  chmodSync(agent, 0o700);
  const run = box.ok(box.worker, 'run', '--agent-light', `sh ${agent}`, '--items', '1', '--attempts', '1', '--minutes', '1');
  assert.match(run.stdout, /submitted #1/u);
  const current = box.git(box.worker, 'rev-parse', 'HEAD');
  const shown = JSON.parse(box.ok(box.repo, 'show', '1', '--json').stdout);
  assert.equal(shown.item_commit, current, 'submit records the HEAD created by this command');
});

/** Create a promise gate for a deterministic overlap between command fact scopes. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Advance the fixture branch using real Git plumbing without running its checkout hooks. */
function advanceHead(box, label) {
  const parent = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const commit = execFileSync(box.env.PULLBOARD_REAL_GIT, ['commit-tree', tree, '-p', parent], {
    cwd: box.repo, env: box.env, input: label, encoding: 'utf8',
  }).trim();
  box.git(box.repo, 'update-ref', 'refs/heads/main', commit);
  return commit;
}

test('settled and concurrent commands do not share Git-fact caches [C7]', async (t) => {
  const box = fixture(t);
  const settledRead = deferred();
  const releaseSettled = deferred();
  const settledAgain = deferred();
  let delayed;
  await withGitFacts(async () => {
    const initial = headCommit(box.repo);
    delayed = (async () => {
      await releaseSettled.promise;
      const first = headCommit(box.repo);
      settledRead.resolve(first);
      await settledAgain.promise;
      return headCommit(box.repo);
    })();
    assert.equal(headCommit(box.repo), initial, 'facts are reused while this command remains active');
  });
  const firstCommit = advanceHead(box, 'expire command cache one');
  releaseSettled.resolve();
  assert.equal(await settledRead.promise, firstCommit, 'a callback inherited from a settled command reads fresh Git state');
  const secondCommit = advanceHead(box, 'expire command cache two');
  settledAgain.resolve();
  assert.equal(await delayed, secondCommit, 'the expired callback does not retain its first late read');

  const aRead = deferred();
  const releaseA = deferred();
  const bRead = deferred();
  const releaseB = deferred();
  const a = withGitFacts(async () => {
    const first = headCommit(box.repo);
    aRead.resolve();
    await releaseA.promise;
    return [first, headCommit(box.repo)];
  });
  await aRead.promise;
  const thirdCommit = advanceHead(box, 'concurrent command cache one');
  const b = withGitFacts(async () => {
    const first = headCommit(box.repo);
    bRead.resolve();
    await releaseB.promise;
    return [first, headCommit(box.repo)];
  });
  await bRead.promise;
  const fourthCommit = advanceHead(box, 'concurrent command cache two');
  releaseA.resolve();
  releaseB.resolve();
  assert.deepEqual(await a, [secondCommit, secondCommit], 'one active command keeps its own fact values');
  assert.deepEqual(await b, [thirdCommit, thirdCommit], 'a concurrent command has a separate fact scope');
  assert.equal(headCommit(box.repo), fourthCommit, 'outside a command scope Git facts are read directly');
});
