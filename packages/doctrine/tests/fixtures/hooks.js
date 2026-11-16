/** Shared fixtures for the merge-hook cases: a plain two-checkout repo and a native board with the CLI's real installed hooks [L3,H16,B26]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';


/** Build the hook fixtures over the gate's child helpers and the config defaults, which the calling test imports. */
export function hookFixtures({ runFixtureChild, runFixtureGit, defaults }) {
  const BIN = join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'cli', 'pullboard.js');

  /** Run private Git with an explicit fixture identity, retaining only nonsensitive diagnostics. */
  function git(root, ...args) {
    return runFixtureGit(args, { cwd: root, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Merge Fixture', GIT_AUTHOR_EMAIL: 'merge@example.invalid',
      GIT_COMMITTER_NAME: 'Merge Fixture', GIT_COMMITTER_EMAIL: 'merge@example.invalid',
    } });
  }

  /** Make separate main and lane checkouts with committed policy and two owned files. */
  function fixture(t, branch = 'main') {
    const scratch = mkdtempSync(join(tmpdir(), 'pullboard-merge-hook-'));
    const main = join(scratch, 'main');
    const lane = join(scratch, 'lane');
    mkdirSync(main);
    const config = { ...defaults(), lanes: { core: { owns: ['core/'], specs: ['L'] }, view: { owns: ['view/'], specs: ['L'] } }, shared: [] };
    git(main, 'init', '-q', '-b', branch);
    git(main, 'config', 'user.name', 'Merge Fixture');
    git(main, 'config', 'user.email', 'merge@example.invalid');
    for (const folder of ['core', 'view']) mkdirSync(join(main, folder));
    writeFileSync(join(main, 'pullboard.json'), JSON.stringify(config));
    writeFileSync(join(main, 'core', 'file'), 'base core\n');
    writeFileSync(join(main, 'view', 'file'), 'base view\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'test: seed private merge fixture');
    git(main, 'worktree', 'add', '-q', '-b', 'core/fixture', lane);
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    return { main, lane, config, context: { root: lane, isMain: false, config, agent: { agent_lane: 'core' } } };
  }

  let nativeTemplate = null;
  after(() => { if (nativeTemplate) rmSync(nativeTemplate.base, { recursive: true, force: true }); });

  /**
   * Give a case an isolated board with the candidate CLI's real installed hooks and a joined lane.
   * Why: init, the seed commit and join cost three CLI starts per case; the first case builds the board once at its
   * final path and snapshots it, and every later case restores that snapshot to the same path, so the board's recorded
   * paths stay valid. Cases run one at a time, so the shared path never holds two live boards.
   */
  function nativeFixture(t) {
    if (!nativeTemplate) {
      const base = mkdtempSync(join(tmpdir(), 'pullboard-native-merge-hook-'));
      nativeTemplate = { base, box: buildNativeFixture(join(base, 'live')), snapshot: join(base, 'snapshot') };
      cpSync(join(base, 'live'), nativeTemplate.snapshot, { recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE });
      return nativeTemplate.box;
    }
    const live = join(nativeTemplate.base, 'live');
    rmSync(live, { recursive: true, force: true });
    cpSync(nativeTemplate.snapshot, live, { recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE });
    return nativeTemplate.box;
  }

  /** Build the native board at dir: real init, a hooked seed commit, a core worktree and a real join. */
  function buildNativeFixture(dir) {
    mkdirSync(dir);
    const shims = join(dir, 'bin');
    const main = join(dir, 'main');
    const lane = join(dir, 'lane');
    mkdirSync(shims);
    mkdirSync(main);
    writeFileSync(join(shims, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
    chmodSync(join(shims, 'pullboard'), 0o755);
    const env = { ...process.env };
    delete env.PULLBOARD_RELAY_TOKEN;
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    Object.assign(env, {
      PATH: `${shims}:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Merge Fixture', GIT_AUTHOR_EMAIL: 'merge@example.invalid',
      GIT_COMMITTER_NAME: 'Merge Fixture', GIT_COMMITTER_EMAIL: 'merge@example.invalid',
      HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    });
    const git = (...args) => runFixtureGit(args, { cwd: main, env, encoding: 'utf8' });
    const gitAt = (cwd, ...args) => {
      return runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
    };
    const cli = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    assert.equal(cli(main, 'init').status, 0, 'the native CLI installs hooks and initializes the board');
    const config = {
      spec: 'SPEC.md', practice: 'PRACTICE.md', gate: '', lease: '2h', verify: { policy: 'any' },
      lanes: { core: { owns: ['core/', 'view/file/x'], specs: ['L3'] }, view: { owns: ['view/'], specs: ['L3'] } }, shared: [],
    };
    writeFileSync(join(main, 'pullboard.json'), JSON.stringify(config, null, 2));
    writeFileSync(join(main, 'SPEC.md'), '# Fixture\n\n## L · Limits\n- L3 [approved, must] Lanes own their paths. | gate: any\n');
    for (const folder of ['core', 'view']) mkdirSync(join(main, folder));
    writeFileSync(join(main, 'core', 'file'), 'base core\n');
    writeFileSync(join(main, 'view', 'file'), 'base view\n');
    git('add', '-A');
    const initial = gitAt(main, 'commit', '-q', '-m', 'chore: seed native merge fixture');
    assert.equal(initial.status, 0, `the native fixture is committed through installed hooks: ${initial.stderr}`);
    git('worktree', 'add', '-q', '-b', 'core/fixture', lane);
    assert.equal(cli(lane, 'join', 'core').status, 0, 'the native CLI joins the lane');
    return { main, lane, env, git: gitAt };
  }

  /** Commit through the installed native pre-commit hook and preserve its exit and diagnostics. */
  function nativeCommit(box, cwd, message = 'test: native fixture commit') {
    return box.git(cwd, 'commit', '-m', message);
  }

  /** Stage a real conflict between coordinator-authored policy versions after the lane joins. */
  function stagedCoordinatorPolicyConflict(t) {
    const box = nativeFixture(t);
    let result = box.git(box.main, 'switch', '-c', 'historical-policy');
    assert.equal(result.status, 0, result.stderr);
    const historicalConfig = { ...box.config, lease: '3h' };
    writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(historicalConfig, null, 2));
    result = box.git(box.main, 'add', 'pullboard.json');
    assert.equal(result.status, 0);
    result = nativeCommit(box, box.main, 'chore: retain historical coordinator policy');
    assert.equal(result.status, 0, result.stderr);
    result = box.git(box.lane, 'reset', '--hard', 'historical-policy');
    assert.equal(result.status, 0, result.stderr);

    result = box.git(box.main, 'switch', 'main');
    assert.equal(result.status, 0, result.stderr);
    const mainConfig = { ...box.config, lease: '4h' };
    writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
    result = box.git(box.main, 'add', 'pullboard.json');
    assert.equal(result.status, 0);
    result = nativeCommit(box, box.main, 'chore: update accepted coordinator policy');
    assert.equal(result.status, 0, result.stderr);
    const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();

    result = box.git(box.lane, 'merge', '--no-edit', 'main');
    assert.equal(result.status, 1, 'the fixture must create a real policy conflict');
    assert.match(result.stdout + result.stderr, /CONFLICT.*pullboard\.json/u);
    assert.match(box.git(box.lane, 'ls-files', '--unmerged').stdout, /pullboard\.json/u);
    const resolvedConfig = { ...box.config, lease: '5h' };
    writeFileSync(join(box.lane, 'pullboard.json'), JSON.stringify(resolvedConfig, null, 2));
    result = box.git(box.lane, 'add', 'pullboard.json');
    assert.equal(result.status, 0);
    return { box, mainHead };
  }

  /** Commit one lane-owned edit and one main-owned edit to force a real pending merge. */
  function diverge(box, { conflict = false } = {}) {
    writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
    git(box.lane, 'add', '-A');
    git(box.lane, 'commit', '-q', '-m', 'test: lane change');
    writeFileSync(join(box.main, 'view', 'file'), 'accepted view\n');
    if (conflict) writeFileSync(join(box.main, 'core', 'file'), 'accepted core\n');
    git(box.main, 'add', '-A');
    git(box.main, 'commit', '-q', '-m', 'test: accepted main change');
    const result = runFixtureChild('git', ['merge', '--no-commit', '--no-ff', git(box.main, 'rev-parse', 'HEAD')], { cwd: box.lane, encoding: 'utf8' });
    assert.equal(result.status, conflict ? 1 : 0, result.failure ?? 'a real merge is pending');
  }
  return { git, fixture, nativeFixture, buildNativeFixture, nativeCommit, stagedCoordinatorPolicyConflict, diverge };
}
