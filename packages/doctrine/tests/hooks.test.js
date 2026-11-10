/** Real merge hooks prove main integration without weakening lane ownership [L3,H16,B26]. */
import { boardBusyError } from "../../store/index.js";
import { openBoardReadOnly } from "../../store/index.js";
import { rowDecisions } from "../../spec/index.js";
import { checkLoosening } from "../index.js";

const approvedRowPorts = { boardBusyError, openBoardReadOnly, rowDecisions, checkLoosening };
import assert from 'node:assert/strict';
import {
  runFixtureChild,
  runFixtureGit,
} from "../../../apps/cli/tests/fixtures/child.js";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from "../../config/index.js";
import { preCommitProblems } from "../../commits/index.js";

const BIN = join(import.meta.dirname, '..', '..', '..', 'apps', 'cli', 'pullboard.js');

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

/** Build an isolated board with the candidate CLI's real installed hooks and a joined lane. */
function nativeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-native-merge-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

test('accepted-main merges preserve exact foreign objects on a primary branch named trunk [L3]', (t) => {
  const box = fixture(t, 'trunk');
  diverge(box);
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), []);
  git(box.lane, 'commit', '-q', '-m', 'test: merge accepted main');
  writeFileSync(join(box.lane, 'view', 'file'), 'outside a merge\n');
  git(box.lane, 'add', '-A');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('outside the core lane: view/file')),
    'the exception ends when the merge ends');
});

test('owned conflict resolutions commit while foreign edits and mode changes remain refused [L3]', (t) => {
  const box = fixture(t);
  diverge(box, { conflict: true });
  writeFileSync(join(box.lane, 'core', 'file'), 'resolved owned core\n');
  git(box.lane, 'add', 'core/file');
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), []);
  writeFileSync(join(box.lane, 'view', 'file'), 'sneaked foreign edit\n');
  git(box.lane, 'add', 'view/file');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('view/file')));
  git(box.lane, 'restore', '--source=MERGE_HEAD', '--staged', '--worktree', '--', 'view/file');
  git(box.lane, 'update-index', '--chmod=+x', 'view/file');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('view/file')),
    'an unchanged blob does not authorize a different executable mode');
});

test('an accepted-main conflict permits a foreign resolution, including literal odd filenames [L3,H16,B26]', (t) => {
  const box = fixture(t);
  const path = 'view/literal [x] \n file';
  writeFileSync(join(box.main, path), 'base literal\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: add literal fixture path');
  git(box.lane, 'merge', '--ff-only', 'main');
  writeFileSync(join(box.lane, path), 'existing lane parent\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: prior foreign parent fixture');
  writeFileSync(join(box.main, path), 'accepted other parent\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: alternate accepted parent');
  const result = runFixtureChild('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: box.lane, encoding: 'utf8' });
  assert.equal(result.status, 1, result.failure ?? 'foreign parents conflict');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('literal')),
    'unresolved stages are never treated as an absent path');
  git(box.lane, 'restore', '--source=HEAD', '--staged', '--worktree', '--', path);
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), []);
  writeFileSync(join(box.lane, path), 'neither parent\n');
  git(box.lane, 'add', '--', path);
  assert.deepEqual(preCommitProblems({ ...box.context, approvedRowPorts }), [],
    'a resolved accepted-main conflict may choose new content at its coordinator-owned path');
});

test('merging an unaccepted branch never authorizes foreign changes [L3]', (t) => {
  const box = fixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: diverge lane');
  git(box.main, 'branch', 'unaccepted');
  const other = join(box.main, '..', 'other');
  git(box.main, 'worktree', 'add', '-q', other, 'unaccepted');
  writeFileSync(join(other, 'view', 'file'), 'unaccepted foreign\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'test: unaccepted branch');
  git(box.lane, 'merge', '--no-commit', '--no-ff', 'unaccepted');
  assert.ok(preCommitProblems({ ...box.context, approvedRowPorts }).some((problem) => problem.includes('view/file')));
});

// Since #2040 a lane may stage a foreign file exactly as accepted main or the merge base has it (a squash of main), so
// these cases stage foreign content that neither has: only a real merge could authorize it, and a tag is not one.
test('installed pre-commit refuses tag-based foreign edit and deletion shortcuts [L3]', (t) => {
  const edited = nativeFixture(t);
  writeFileSync(join(edited.lane, 'core', 'file'), 'lane core\n');
  let result = edited.git(edited.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(edited, edited.lane);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(edited.main, 'view', 'file'), 'accepted view\n');
  result = edited.git(edited.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(edited, edited.main);
  assert.equal(result.status, 0, result.stderr);
  result = edited.git(edited.lane, 'tag', 'MERGE_HEAD', 'main');
  assert.equal(result.status, 0);
  writeFileSync(join(edited.lane, 'view', 'file'), 'builder view\n');
  result = edited.git(edited.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(edited, edited.lane);
  assert.notEqual(result.status, 0, 'a tag cannot authorize a foreign edit');
  assert.match(result.stderr, /outside the core lane: view\/file/u);

  const deleted = nativeFixture(t);
  writeFileSync(join(deleted.lane, 'core', 'file'), 'lane core\n');
  result = deleted.git(deleted.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(deleted, deleted.lane);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(deleted.main, 'view', 'file'), 'accepted view\n');
  result = deleted.git(deleted.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(deleted, deleted.main);
  assert.equal(result.status, 0, result.stderr);
  result = deleted.git(deleted.lane, 'tag', 'MERGE_HEAD', 'main');
  assert.equal(result.status, 0);
  unlinkSync(join(deleted.lane, 'view', 'file'));
  result = deleted.git(deleted.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(deleted, deleted.lane);
  assert.notEqual(result.status, 0, 'a tag cannot authorize a foreign deletion');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test('installed pre-commit refuses a hand-written MERGE_HEAD already in HEAD [L3]', (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.equal(result.status, 0, result.stderr);
  unlinkSync(join(box.main, 'view', 'file'));
  result = box.git(box.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main);
  assert.equal(result.status, 0, result.stderr);
  const deletion = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(box.main, 'view', 'file'), 'accepted re-add\n');
  result = box.git(box.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main);
  assert.equal(result.status, 0, result.stderr);
  result = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(result.status, 0, result.stderr);
  result = nativeCommit(box, box.lane, 'test: merge accepted main');
  assert.equal(result.status, 0, result.stderr);
  const mergeHeadPath = box.git(box.lane, 'rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim();
  writeFileSync(mergeHeadPath, `${deletion}\n`);
  unlinkSync(join(box.lane, 'view', 'file'));
  result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.notEqual(result.status, 0, 'a target already in HEAD cannot authorize a foreign deletion');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test('installed pre-commit matches an exact foreign path during a merge [L3]', (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'shared blob\n');
  result = box.git(box.main, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main);
  assert.equal(result.status, 0, result.stderr);
  result = box.git(box.lane, 'merge', '--no-commit', '--no-ff', 'main');
  assert.equal(result.status, 0, result.stderr);
  unlinkSync(join(box.lane, 'view', 'file'));
  mkdirSync(join(box.lane, 'view', 'file'));
  writeFileSync(join(box.lane, 'view', 'file', 'x'), 'shared blob\n');
  result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane);
  assert.notEqual(result.status, 0, 'the owned child path cannot impersonate its foreign parent path');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test("merging main brings in main's own changes outside the lane [H16,B26]", (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'feat(core): update owned file [L3]');
  assert.equal(result.status, 0, result.stderr);

  const mainConfig = { ...box.config, lease: '3h' };
  writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
  result = box.git(box.main, 'add', 'pullboard.json');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: update main policy');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the automatic merge completed and created a merge commit');
  assert.deepEqual(JSON.parse(readFileSync(join(box.lane, 'pullboard.json'), 'utf8')), mainConfig,
    'the exact policy change from main is present in the lane checkout');
});

test('resolving a foreign main conflict completes the merge and names the coordinator [H16,B26]', (t) => {
  const { box, mainHead } = stagedCoordinatorPolicyConflict(t);
  const result = nativeCommit(box, box.lane, 'chore: resolve accepted coordinator policy');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /the coordinator owns pullboard\.json/u);
  assert.equal(box.git(box.lane, 'rev-parse', 'HEAD^2').stdout.trim(), mainHead,
    'the resolved commit retains the accepted main commit as its second parent');
});

test('a foreign edit beside a resolved main conflict remains refused [H16,B26]', (t) => {
  const { box } = stagedCoordinatorPolicyConflict(t);
  writeFileSync(join(box.lane, 'view', 'file'), 'unrelated foreign edit\n');
  let result = box.git(box.lane, 'add', 'view/file');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'chore: resolve policy with foreign edit');
  assert.notEqual(result.status, 0, 'the conflict exception cannot authorize unrelated foreign content');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the refused commit did not finish the merge');
});

test('a mode change on a resolved foreign main conflict remains refused [H16,B26]', (t) => {
  const { box } = stagedCoordinatorPolicyConflict(t);
  chmodSync(join(box.lane, 'pullboard.json'), 0o755);
  const staged = box.git(box.lane, 'add', 'pullboard.json');
  assert.equal(staged.status, 0, staged.stderr);
  const result = nativeCommit(box, box.lane, 'chore: resolve policy with mode change');
  assert.notEqual(result.status, 0, 'conflict resolution cannot authorize a new executable mode');
  assert.match(result.stderr, /outside the core lane: pullboard\.json/u);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the refused commit did not finish the merge');
});

test('an inherited main candidate cannot authorize an automatic merge from an unaccepted branch [H16,B26]', (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  let result = box.git(box.lane, 'add', '-A');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'feat(core): update owned file [L3]');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.main, 'switch', '-c', 'unaccepted');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'unaccepted foreign\n');
  result = box.git(box.main, 'add', 'view/file');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: change a foreign file');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.main, 'switch', 'main');
  assert.equal(result.status, 0, result.stderr);
  const mainConfig = { ...box.config, lease: '3h' };
  writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
  result = box.git(box.main, 'add', 'pullboard.json');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: update main policy');
  assert.equal(result.status, 0, result.stderr);
  const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();
  box.env[`GITHEAD_${mainHead}`] = 'main';

  result = box.git(box.lane, 'merge', '--no-edit', 'unaccepted');
  assert.notEqual(result.status, 0, 'the lane hook refuses the real unaccepted merge head');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
  assert.notEqual(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0,
    'the refused merge did not create a merge commit');
});

test('an inherited main candidate cannot authorize an ordinary foreign commit [H16,B26]', (t) => {
  const box = nativeFixture(t);
  const mainConfig = { ...box.config, lease: '3h' };
  writeFileSync(join(box.main, 'pullboard.json'), JSON.stringify(mainConfig, null, 2));
  let result = box.git(box.main, 'add', 'pullboard.json');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.main, 'chore: update main policy');
  assert.equal(result.status, 0, result.stderr);
  const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();
  box.env[`GITHEAD_${mainHead}`] = 'main';

  writeFileSync(join(box.lane, 'view', 'file'), 'sneaked foreign edit\n');
  result = box.git(box.lane, 'add', 'view/file');
  assert.equal(result.status, 0);
  result = nativeCommit(box, box.lane, 'chore: stage a foreign edit');
  assert.notEqual(result.status, 0, 'the ordinary pre-commit hook ignores GITHEAD candidates');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test('removing a conflicted foreign file resolves a main merge and names the coordinator [H16,B26]', (t) => {
  const box = nativeFixture(t);
  let result = box.git(box.main, 'switch', '-c', 'historical-view');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'historical view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: retain historical view file');
  assert.equal(result.status, 0, result.stderr);
  result = box.git(box.lane, 'reset', '--hard', 'historical-view');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.main, 'switch', 'main').status, 0);
  writeFileSync(join(box.main, 'view', 'file'), 'current view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: update the view file on main');
  assert.equal(result.status, 0, result.stderr);
  const mainHead = box.git(box.main, 'rev-parse', 'HEAD').stdout.trim();

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 1, 'the fixture must create a real conflict in a foreign file');
  assert.match(box.git(box.lane, 'ls-files', '--unmerged').stdout, /view\/file/u);
  assert.equal(box.git(box.lane, 'rm', '-q', 'view/file').status, 0);
  result = nativeCommit(box, box.lane, 'chore: resolve the view conflict by removing it');
  assert.equal(result.status, 0, `removing the conflicted file is a resolution, not a foreign edit: ${result.stderr}`);
  assert.match(result.stderr, /the coordinator owns view\/file/u, 'the resolution names the coordinator as the owner');
  assert.equal(box.git(box.lane, 'rev-parse', 'HEAD^2').stdout.trim(), mainHead, 'the merge completed with main as its second parent');

  // Outside a conflict, writing the foreign file again is still the lane touching it.
  mkdirSync(join(box.lane, 'view'), { recursive: true });
  writeFileSync(join(box.lane, 'view', 'file'), 'lane rewrite\n');
  assert.equal(box.git(box.lane, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.lane, 'chore: rewrite a foreign file');
  assert.notEqual(result.status, 0, 'a foreign edit with no conflict stays refused');
  assert.match(result.stderr, /outside the core lane: view\/file/u);
});

test("merging main brings in the foreign files main added, deleted and renamed [H16,B26]", (t) => {
  const box = nativeFixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  assert.equal(box.git(box.lane, 'add', '-A').status, 0);
  let result = nativeCommit(box, box.lane, 'feat(core): update owned file [L3]');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'added'), 'added on main\n');
  assert.equal(box.git(box.main, 'add', 'view/added').status, 0);
  assert.equal(box.git(box.main, 'mv', 'view/file', 'view/moved').status, 0);
  result = nativeCommit(box, box.main, 'chore: add and rename view files on main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.main, 'rm', '-q', 'view/added').status, 0);
  result = nativeCommit(box, box.main, 'chore: delete a view file on main');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 0, `main's own additions, deletions and renames merge: ${result.stderr}`);
  assert.equal(box.git(box.lane, 'rev-parse', '--verify', 'HEAD^2').status, 0, 'the merge completed');
  assert.equal(readFileSync(join(box.lane, 'view', 'moved'), 'utf8').length > 0, true, "main's rename arrived");
});

test('keeping this side of a conflicted foreign file resolves a main merge [H16,B26]', (t) => {
  const box = nativeFixture(t);
  let result = box.git(box.main, 'switch', '-c', 'historical-view');
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(box.main, 'view', 'file'), 'historical view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: retain historical view file');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(box.git(box.lane, 'reset', '--hard', 'historical-view').status, 0);
  assert.equal(box.git(box.main, 'switch', 'main').status, 0);
  writeFileSync(join(box.main, 'view', 'file'), 'current view\n');
  assert.equal(box.git(box.main, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.main, 'chore: update the view file on main');
  assert.equal(result.status, 0, result.stderr);

  result = box.git(box.lane, 'merge', '--no-edit', 'main');
  assert.equal(result.status, 1, 'the fixture must create a real conflict in a foreign file');
  assert.equal(box.git(box.lane, 'checkout', '--ours', '--', 'view/file').status, 0);
  assert.equal(box.git(box.lane, 'add', 'view/file').status, 0);
  result = nativeCommit(box, box.lane, 'chore: keep this side of the view conflict');
  assert.equal(result.status, 0, `keeping one side is a resolution: ${result.stderr}`);
  assert.match(result.stderr, /the coordinator owns view\/file/u);

  // Renaming a conflicted file to a name main never had is the worktree's own new path, refused with its owner named.
  assert.equal(box.git(box.lane, 'mv', 'view/file', 'view/renamed').status, 0);
  result = nativeCommit(box, box.lane, 'chore: rename a foreign file');
  assert.notEqual(result.status, 0, 'a new foreign path the worktree creates stays refused');
  assert.match(result.stderr, /outside the core lane: view\/renamed \(\w+'s\)/u, 'the refusal names the new path and its owner');
});
