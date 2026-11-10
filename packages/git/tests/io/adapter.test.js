/** @pullboard-test-input source-tree */
/** Shared real/in-memory Git contracts and the staged source-launch ratchet [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { currentGitAdapter } from '../../index.js';
import { gitExecFileSync } from '../../index.js';
import { gitSpawn } from '../../index.js';
import { gitSpawnSync } from '../../index.js';
import { realGitAdapter } from '../../index.js';
import { withGitContractAdapter as withGitAdapter } from '../../index.js';
import { createMemoryGitAdapter } from '../../index.js';
import {
  gitLaunches,
  gitLaunchGrowth,
  gitLaunchReport,
  loweredGitLaunchBaseline,
} from '../../index.js';
import { cleanGitEnvironment } from '../../index.js';
import { contains } from '../../index.js';
import { git } from '../../index.js';
import { gitConfig } from '../../index.js';
import { headCommit } from '../../index.js';
import { headTree } from '../../index.js';
import { patchId } from '../../index.js';
import { tryGit } from '../../index.js';
import { withGitFacts } from '../../index.js';
import { withGitReadFacts } from '../../index.js';
import { trunkRef } from '../../light.js';
import { runFixtureExecFile } from '../../../../apps/cli/tests/fixtures/child.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FLAGS = ['--no-replace-objects', '-c', 'core.quotepath=false', '-c', 'gc.auto=0']; // gc.auto=0 joined the shared GIT_FLAGS in packages/git/src/io/main.js
const BEFORE = { 'stable.txt': 'same\n', 'changed.txt': 'before\n', 'old.txt': 'removed\n' };
const AFTER = { 'stable.txt': 'same\n', 'changed.txt': 'after\n', 'new space.txt': 'added\n', 'line\nbreak.txt': 'framed\n', 'bytes.bin': Buffer.from([0, 255, 10, 13]) };

test('plain retained trunk reads avoid Git; ambiguous configuration still asks Git [C7]', t => {
  const box = fixture(t, 'real');
  const calls = [];
  const adapter = { ...realGitAdapter, spawnSync(args, options) { calls.push(args); return realGitAdapter.spawnSync(args, options); } };
  assert.equal(withGitAdapter(adapter, () => trunkRef(box.root)), 'main');
  assert.equal(calls.length, 0);
  const config = join(box.root, '.git', 'config');
  writeFileSync(config, `${readFileSync(config, 'utf8')}\n[pullboard]\n  trunk = "other"\n`);
  assert.equal(withGitAdapter(adapter, () => trunkRef(box.root)), 'other');
  assert.equal(calls.length, 1, 'quoted or repeated values retain Git semantics');
});

/** Build equivalent repository states; only the real contract creates files and runs setup Git. */
function fixture(t, implementation) {
  const env = { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Adapter fixture', GIT_AUTHOR_EMAIL: 'adapter@example.test',
    GIT_COMMITTER_NAME: 'Adapter fixture', GIT_COMMITTER_EMAIL: 'adapter@example.test' };
  let root = resolve('/virtual/pullboard-git-contract');
  let base = '1'.repeat(40);
  let tip = '2'.repeat(40);
  let baseTree = '3'.repeat(40);
  let tipTree = '4'.repeat(40);
  if (implementation === 'real') {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-git-adapter-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    /** Set up real Git independently of the production adapter under contract. */
    const setup = (...args) => runFixtureExecFile('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    setup('init', '-q', '-b', 'main');
    setup('config', '--local', '--replace-all', 'pullboard.trunk', 'main');
    for (const [path, bytes] of Object.entries(BEFORE)) writeFileSync(join(root, path), bytes);
    setup('add', '-A');
    setup('commit', '-qm', 'before');
    base = setup('rev-parse', 'HEAD');
    baseTree = setup('rev-parse', 'HEAD^{tree}');
    rmSync(join(root, 'old.txt'));
    for (const [path, bytes] of Object.entries(AFTER)) writeFileSync(join(root, path), bytes);
    setup('add', '-A');
    setup('commit', '-qm', 'after');
    tip = setup('rev-parse', 'HEAD');
    tipTree = setup('rev-parse', 'HEAD^{tree}');
  }
  const seed = { root, branch: 'main', head: tip, config: { 'pullboard.trunk': 'main' }, commits: [
    { oid: base, tree: baseTree, files: BEFORE },
    { oid: tip, tree: tipTree, parents: [base], files: AFTER },
  ] };
  const adapter = implementation === 'real' ? realGitAdapter : createMemoryGitAdapter([seed]);
  return { root, env, base, tip, baseTree, tipTree, adapter, seed };
}

/** Exercise identical assertions on each implementation rather than prescribing fake responses. */
for (const implementation of ['real', 'memory']) {
  test(`Git adapter shared stateful contract: ${implementation} [C7]`, async t => {
    const box = fixture(t, implementation);
    const options = { cwd: box.root, env: box.env, encoding: 'utf8' };
    /** Run a contract command through the production injection point. */
    const run = (...args) => withGitAdapter(box.adapter, () => gitSpawnSync([...FLAGS, ...args], options));

    await t.test('revision, parent and tree identities, quiet missing refs [C7]', () => {
      for (const [name, expected] of [['HEAD', box.tip], ['main', box.tip], ['refs/heads/main', box.tip],
        [box.base, box.base], ['HEAD^', box.base], ['HEAD^1^{commit}', box.base], ['HEAD^{tree}', box.tipTree]]) {
        const found = run('rev-parse', '--verify', '--quiet', name);
        assert.equal(found.status, 0);
        assert.equal(found.stdout, `${expected}\n`);
      }
      assert.equal(run('rev-parse', '--verify', '--quiet', 'missing^{commit}').status, 1);
      assert.equal(run('rev-parse', '--verify', 'missing').status, 128);
      assert.equal(run('rev-parse', '--show-toplevel').stdout.trim(), box.root);
      assert.equal(run('rev-parse', '--is-shallow-repository').stdout, 'false\n');
    });

    await t.test('symbolic branch and detached HEAD [C7]', () => {
      assert.equal(run('symbolic-ref', '--quiet', 'HEAD').stdout, 'refs/heads/main\n');
      assert.equal(run('symbolic-ref', '-q', '--short', 'HEAD').stdout, 'main\n');
      if (implementation === 'real') {
        runFixtureExecFile('git', ['checkout', '-q', '--detach', box.tip], options);
        try { assert.equal(run('symbolic-ref', '--quiet', 'HEAD').status, 1); }
        finally { runFixtureExecFile('git', ['checkout', '-q', 'main'], options); }
      } else {
        const detached = createMemoryGitAdapter([{ ...box.seed, branch: null }]);
        assert.equal(detached.spawnSync(['symbolic-ref', '--quiet', 'HEAD'], options).status, 1);
      }
    });

    await t.test('local config reads, missing keys and subsequent replacement [C7]', () => {
      assert.equal(run('config', '--local', '--get', 'pullboard.trunk').stdout, 'main\n');
      assert.equal(run('config', '--get', 'pullboard.missing').status, 1);
      assert.equal(run('config', '--local', '--replace-all', 'pullboard.contract', 'first').status, 0);
      assert.equal(run('config', '--replace-all', 'pullboard.contract', 'second').status, 0);
      assert.equal(run('config', '--get', 'pullboard.contract').stdout, 'second\n');
      assert.equal(run('config', '--local', '--replace-all', 'Remote.Upstream.URL', 'case-preserved').status, 0);
      assert.equal(run('config', '--get', 'remote.Upstream.url').stdout, 'case-preserved\n');
      assert.equal(run('config', '--get', 'remote.upstream.url').status, 1);
    });

    await t.test('runner command config overrides effective reads, leaves local state intact [C7]', () => {
      const env = { ...box.env, GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'pullboard.trunk', GIT_CONFIG_VALUE_1: 'command-value',
        GIT_CONFIG_KEY_2: 'maintenance.auto', GIT_CONFIG_VALUE_2: 'false' };
      const command = box.adapter.spawnSync(['config', '--get', 'pullboard.trunk'], { ...options, env });
      assert.equal(command.status, 0);
      assert.equal(command.stdout, 'command-value\n');
      assert.equal(box.adapter.spawnSync(['config', '--local', '--get', 'pullboard.trunk'], { ...options, env }).stdout, 'main\n');
      assert.equal(run('config', '--get', 'pullboard.trunk').stdout, 'main\n');
      assert.equal(box.adapter.spawnSync(['rev-parse', '--verify', 'HEAD'], { ...options, env }).stdout, `${box.tip}\n`);
    });

    await t.test('committed text, binary blobs and object metadata [C7]', () => {
      assert.equal(run('show', 'HEAD:changed.txt').stdout, 'after\n');
      assert.equal(run('show', `${box.base}:changed.txt`).stdout, 'before\n');
      assert.equal(run('show', 'HEAD:missing').status, 128);
      const bytes = AFTER['bytes.bin'];
      const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      for (const name of ['HEAD:bytes.bin', blob]) {
        assert.equal(run('cat-file', '-e', name).status, 0);
        assert.equal(run('cat-file', '-t', name).stdout, 'blob\n');
        assert.equal(run('cat-file', '-s', name).stdout, `${bytes.length}\n`);
        assert.deepEqual(box.adapter.execFileSync(['cat-file', 'blob', name], { cwd: box.root, env: box.env }), bytes);
      }
      assert.equal(run('cat-file', '-t', 'HEAD').stdout, 'commit\n');
      assert.equal(run('cat-file', '-t', box.tipTree).stdout, 'tree\n');
      assert.equal(run('cat-file', '-e', 'HEAD:absent').status, 128);
    });

    await t.test('NUL-framed tree names and committed diff without rename heuristics [C7]', () => {
      const names = Object.keys(AFTER).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      assert.equal(run('ls-tree', '-r', '-z', '--name-only', 'HEAD').stdout, names.map(path => `${path}\0`).join(''));
      assert.equal(run('ls-tree', '-r', '-z', '--name-only', 'missing').status, 128);
      const changed = ['bytes.bin', 'changed.txt', 'line\nbreak.txt', 'new space.txt', 'old.txt'];
      assert.equal(run('diff', '--no-renames', '--name-only', '-z', box.base, box.tip).stdout, changed.map(path => `${path}\0`).join(''));
      assert.equal(run('diff', '--no-renames', '--name-only', '-z', box.tip, box.tip).stdout, '');
      assert.equal(run('diff', '--no-renames', '--name-only', '-z', 'missing', box.tip).status, 128);
    });

    await t.test('ancestry statuses and stateful ref updates [C7]', () => {
      assert.equal(run('merge-base', '--is-ancestor', box.base, box.tip).status, 0);
      assert.equal(run('merge-base', '--is-ancestor', box.tip, box.base).status, 1);
      assert.equal(run('merge-base', '--is-ancestor', box.tip, box.tip).status, 0);
      assert.equal(run('merge-base', '--is-ancestor', 'missing', box.tip).status, 128);
      assert.equal(run('update-ref', 'refs/heads/contract', box.base).status, 0);
      assert.equal(run('rev-parse', '--verify', 'contract').stdout, `${box.base}\n`);
      assert.equal(run('update-ref', 'refs/heads/contract', box.tip).status, 0);
      assert.equal(run('rev-parse', '--verify', 'contract').stdout, `${box.tip}\n`);
      assert.equal(run('update-ref', 'refs/heads/contract', 'missing').status, 128);
      assert.equal(run('rev-parse', '--verify', 'contract').stdout, `${box.tip}\n`, 'a failed mutation preserves the prior ref');
    });

    await t.test('Node output encoding, ignored streams and throwing failure [C7]', () => {
      const binary = box.adapter.spawnSync(['show', 'HEAD:bytes.bin'], { cwd: box.root, env: box.env });
      assert.equal(binary.signal, null);
      assert.deepEqual(binary.stdout, AFTER['bytes.bin']);
      assert.deepEqual(binary.output, [null, binary.stdout, binary.stderr]);
      const ignored = box.adapter.spawnSync(['rev-parse', 'HEAD'], { ...options, stdio: 'ignore' });
      assert.equal(ignored.stdout, null);
      assert.equal(ignored.stderr, null);
      assert.throws(() => box.adapter.execFileSync(['show', 'HEAD:missing'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
        assert.equal(error.status, 128);
        assert.equal(error.signal, null);
        assert.ok(error.stderr.length > 0);
        return true;
      });
      assert.equal(box.adapter.spawnSync(['rev-parse', 'HEAD'], { ...options, cwd: join(box.root, 'absent') }).status === 0, false);
      assert.equal(box.adapter.spawnSync(['-C', box.root, '--no-optional-locks', 'rev-parse', 'HEAD'], { ...options, cwd: '/' }).stdout, `${box.tip}\n`);
    });

    await t.test('existing Pullboard helpers use the injected implementation and invalidate mutated facts [C7]', async () => {
      await withGitAdapter(box.adapter, () => withGitFacts(async () => {
        assert.equal(headCommit(box.root), box.tip);
        assert.equal(headTree(box.root), box.tipTree);
        assert.equal(git(box.root, ['show', 'HEAD:changed.txt'], { env: box.env }), 'after');
        assert.equal(tryGit(box.root, ['show', 'HEAD:missing'], { env: box.env }).status, 128);
        assert.equal(gitConfig(box.root, 'pullboard.trunk').stdout, 'main');
        assert.equal(contains(box.root, box.base, box.tip), true);
        git(box.root, ['config', '--local', '--replace-all', 'pullboard.trunk', 'changed'], { env: box.env });
        assert.equal(gitConfig(box.root, 'pullboard.trunk').stdout, 'changed');
        git(box.root, ['update-ref', 'refs/heads/main', box.base], { env: box.env });
        assert.equal(headCommit(box.root), box.base);
        assert.equal(headTree(box.root), box.baseTree);
        git(box.root, ['update-ref', 'refs/heads/main', box.tip], { env: box.env });
        assert.equal(withGitReadFacts(() => headCommit(box.root)), box.tip);
      }));
    });
  });
}

test('in-memory Git rejects uncontracted operations without real-process fallback [C7]', () => {
  const adapter = createMemoryGitAdapter([]);
  assert.throws(() => withGitAdapter(adapter, () => gitSpawn(['status'])), { code: 'GIT_ADAPTER_UNSUPPORTED' });
  const seed = { root: '/virtual/known', head: '1'.repeat(40), commits: [{ oid: '1'.repeat(40), tree: '2'.repeat(40) }] };
  const known = createMemoryGitAdapter([seed]);
  for (const args of [['status', '--porcelain'], ['rev-parse', '--git-dir'], ['config', '--global', '--get', 'x'], ['show', '--format=%B', 'HEAD'], ['ls-tree', 'HEAD'], ['merge-base', 'HEAD', 'HEAD']]) {
    assert.throws(() => known.spawnSync(args, { cwd: seed.root }), { code: 'GIT_ADAPTER_UNSUPPORTED' });
  }
  assert.throws(() => known.spawnSync(['rev-parse', 'HEAD'], { cwd: seed.root, env: { GIT_DIR: '/elsewhere' } }), { code: 'GIT_ADAPTER_UNSUPPORTED' });
});

test('async and nested Git implementations isolate caches and restore after failure [C7]', async () => {
  const root = '/virtual/shared';
  /** Build independently seeded state for the same logical root. */
  const memory = digit => createMemoryGitAdapter([{ root, head: digit.repeat(40), commits: [{ oid: digit.repeat(40), tree: 'a'.repeat(40) }] }]);
  const first = memory('1');
  const second = memory('2');
  await withGitFacts(async () => {
    await Promise.all([first, second].map(adapter => withGitAdapter(adapter, async () => {
      const before = headCommit(root);
      await Promise.resolve();
      assert.equal(headCommit(root), before);
      assert.equal(currentGitAdapter(), adapter);
    })));
    withGitAdapter(first, () => {
      assert.equal(headCommit(root), '1'.repeat(40));
      assert.throws(() => withGitAdapter(second, () => {
        assert.equal(headCommit(root), '2'.repeat(40));
        throw new Error('nested stop');
      }), /nested stop/u);
      assert.equal(headCommit(root), '1'.repeat(40));
    });
  });
  assert.equal(currentGitAdapter(), realGitAdapter);
  assert.throws(() => withGitAdapter({}, () => {}), /needs spawnSync/u);
  assert.throws(() => withGitAdapter(first, () => gitExecFileSync(['show', 'HEAD:missing'], { cwd: root, encoding: 'utf8' })), error => error.status === 128);
});

test('Git transport preserves caller arguments, stdin and bounds at the migrated seam [C7]', () => {
  const calls = [];
  const observer = {
    ...realGitAdapter,
    /** Observe transport without claiming to model Git's patch-id algorithm. */
    spawnSync(args, options) {
      calls.push({ args, options });
      return { status: 0, stdout: args.includes('patch-id') ? `${'a'.repeat(40)} ${'b'.repeat(40)}\n` : 'the patch\n', stderr: '' };
    },
  };
  assert.equal(withGitAdapter(observer, () => patchId('/virtual/patch', 'before', 'after')), 'a'.repeat(40));
  assert.deepEqual(calls.map(call => call.args), [[...FLAGS, 'diff', 'before', 'after'], [...FLAGS, 'patch-id', '--stable']]);
  assert.equal(calls[0].options.maxBuffer, 32 * 1024 * 1024);
  assert.equal(calls[1].options.input, 'the patch\n');
  assert.equal(calls[0].options.cwd, '/virtual/patch');
  assert.equal(calls[0].options.env.GIT_NO_REPLACE_OBJECTS, '1');
});

test('real Git streaming implementation preserves child output and completion [C7]', async t => {
  const box = fixture(t, 'real');
  const child = withGitAdapter(realGitAdapter, () => gitSpawn(['rev-parse', 'HEAD'], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let output = '';
  let diagnostic = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { diagnostic += bytes; });
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolveResult({ status, signal }));
  });
  assert.deepEqual(result, { status: 0, signal: null });
  assert.equal(output, `${box.tip}\n`);
  assert.equal(diagnostic, '');
});

test('literal Git launch ratchet counts code and aliases, rejects growth, and reports the remaining migration [C7]', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'packages/git/src/io/launch/baseline.json'), 'utf8'));
  const report = gitLaunchReport(ROOT);
  assert.ok(report.total <= 81, 'this slice migrates all eight direct packages/git/index.js launches from the original 89');
  assert.equal(report.total, Object.values(baseline.files).reduce((sum, count) => sum + count, 0), 'lower the committed allowance when a caller migrates');
  assert.equal(baseline.originalTotal, 89);
  assert.deepEqual(gitLaunchGrowth(report, baseline.files), []);
  const sample = "import {spawnSync as launch} from 'node:child_process';\n// spawn('git', [])\nconst text = `spawnSync('git', [])`;\nlaunch(/* gap */ 'git', []); cp.spawnSync('git', []);";
  assert.deepEqual(gitLaunches(sample).map(call => call.api), ['launch', 'spawnSync']);
  const added = { ...report, files: { ...report.files, 'src/new-stray.js': gitLaunches("spawnSync('git', ['status']);") } };
  assert.deepEqual(gitLaunchGrowth(added, baseline.files), [{ file: 'src/new-stray.js', actual: 1, allowed: 0 }]);
  const first = Object.keys(report.files)[0];
  assert.equal(gitLaunchGrowth({ files: { [first]: [...report.files[first], { api: 'spawn', line: 1 }] } }, baseline.files)[0].actual, baseline.files[first] + 1);
  assert.deepEqual(loweredGitLaunchBaseline(report, baseline), { growth: [], baseline }, 'the committed allowance is what the writer records');
  assert.deepEqual(loweredGitLaunchBaseline(added, baseline), { growth: [{ file: 'src/new-stray.js', actual: 1, allowed: 0 }] });
  const { [first]: _migrated, ...rest } = report.files;
  const lowered = loweredGitLaunchBaseline({ ...report, files: rest }, baseline).baseline;
  assert.equal(lowered.files[first], undefined);
  assert.equal(lowered.originalTotal, 89);
});

/** The scan covers packages at their true paths, so a launcher cannot hide in a cell. */
test('the Git launch scan counts package launchers at their true path and fails a planted one naming the file [C7,doctrine:CD64]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-package-git-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const moved = join(root, 'packages/git/src/io');
  const cell = join(root, 'packages/widget/src/shell');
  mkdirSync(join(root, 'src'));
  mkdirSync(moved, { recursive: true });
  mkdirSync(cell, { recursive: true });
  mkdirSync(join(root, 'packages/widget/tests'));
  writeFileSync(join(root, 'src/legacy.js'), "spawnSync('git', ['status']);\n");
  writeFileSync(join(moved, 'adapter.js'), "spawn('git', []);\n");
  writeFileSync(join(root, 'packages/widget/tests/fixture.js'), "spawnSync('git', ['init']);\n");
  const allowed = { 'src/legacy.js': 1 };
  const report = gitLaunchReport(root);
  assert.deepEqual(Object.keys(report.files), ['src/legacy.js'], 'the adapter and test fixtures are excluded');
  assert.deepEqual(gitLaunchGrowth(report, allowed), []);
  writeFileSync(join(cell, 'planted.js'), "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['log']);\n");
  const planted = gitLaunchReport(root);
  assert.equal(planted.total, 2);
  assert.deepEqual(gitLaunchGrowth(planted, allowed), [{ file: 'packages/widget/src/shell/planted.js', actual: 1, allowed: 0 }]);
  assert.deepEqual(loweredGitLaunchBaseline(planted, { files: allowed }).growth.map(entry => entry.file), ['packages/widget/src/shell/planted.js']);
});

test('the committed Git launch allowance names only files that still launch Git at that path [C7]', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'packages/git/src/io/launch/baseline.json'), 'utf8'));
  const report = gitLaunchReport(ROOT);
  assert.deepEqual(Object.keys(baseline.files).filter(file => !report.files[file]), [], 'a moved or migrated file leaves a stale allowance');
});

/** Proves the item's single clause: every launch beyond the allowance goes through the adapter, and the allowance never rises. */
test('clause 1: no direct Git launch exceeds the committed allowance and the allowance stays within its original total [C7]', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'packages/git/src/io/launch/baseline.json'), 'utf8'));
  const report = gitLaunchReport(ROOT);
  assert.deepEqual(gitLaunchGrowth(report, baseline.files), [], 'a direct Git launch beyond the allowance must go through packages/git');
  assert.ok(Object.values(baseline.files).reduce((sum, count) => sum + count, 0) <= baseline.originalTotal, 'the allowance never rises above its original total');
});
