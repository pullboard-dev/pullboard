/** Canonical doctrine naming keeps legacy repos and the stable state API readable [D1,D2,A5]. */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { projectState } from '../../src/io/view.js';
import { checkAtCommit } from '../../../runner/index.js';
import { doctrineHistory } from '../../../../packages/doctrine/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
const DOCTRINE = 'DOCTRINE.md';
const PRACTICE = 'PRACTICE.md';
const TEMP_DIRS = [];
const LEGACY_RULES = '# Legacy doctrine\n\n## L · Local\n- L1 [fact] Keep the legacy rule.\n';
const LOCAL_RULE = '\n## L · Local\n- L1 [fact] Keep this repo rule.\n';

/** Remove all fixture repos and their private SQLite homes after the tests finish. */
function cleanup() {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
}

after(cleanup);

/** Quote a shell argument for the private hook shim. */
function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Make private Git and pullboard homes with a real CLI subprocess and PATH shim. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-name-'));
  TEMP_DIRS.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Doctrine name fixture',
    GIT_AUTHOR_EMAIL: 'doctrine-name@example.invalid',
    GIT_COMMITTER_NAME: 'Doctrine name fixture',
    GIT_COMMITTER_EMAIL: 'doctrine-name@example.invalid',
  });
  /** Run Git with the fixture's isolated identity and configuration. */
  function git(cwd, ...args) {
    return runFixtureGit(args, { cwd, env });
  }
  /** Run one real CLI command in this process and keep stdout, stderr and status available to assertions. */
  function inProcess(cwd, ...args) {
    return runCliInProcess(args, { cwd, env });
  }
  return { dir, env, git, inProcess };
}

/** Initialize a throwaway repo, optionally with the historical filename already present. */
async function initializedRepo(box, name, { legacy = false } = {}) {
  const root = join(box.dir, name);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  if (legacy) writeFileSync(join(root, PRACTICE), LEGACY_RULES);
  const result = await box.inProcess(root, 'init');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { ...box, root, init: result };
}

/** Append one valid local rule under its own doctrine section. */
function addLocalRule(root, file = DOCTRINE) {
  writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8').trimEnd()}${LOCAL_RULE}`);
}

/** Run spec JSON and return its rows after checking the CLI result. */
async function specRows(box, root) {
  const result = await box.inProcess(root, 'spec', '--json');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).rows;
}

/** Return doctor findings from the versioned JSON output. */
async function doctorProblems(box, root) {
  const result = await box.inProcess(root, 'doctor', '--json');
  assert.ok([0, 1].includes(result.status), `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).problems;
}

test('[D1,D2,A5] init chooses DOCTRINE and preserves its rows through checks, JSON, view and rerun', async function canonicalDoctrineFile() {
  const box = sandbox();
  const repo = await initializedRepo(box, 'new-repo');
  const doctrinePath = join(repo.root, DOCTRINE);
  assert.equal(existsSync(doctrinePath), true, 'a fresh init writes the canonical doctrine file');
  assert.equal(existsSync(join(repo.root, PRACTICE)), false, 'a fresh init does not create the legacy filename');
  const config = JSON.parse(readFileSync(join(repo.root, 'pullboard.json'), 'utf8'));
  assert.equal(config.practice, DOCTRINE, 'the existing config field points at the canonical file');
  const help = await box.inProcess(repo.root, 'help', '--all');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /doctrine \(house rules for agentic development\)/u);
  addLocalRule(repo.root);
  const saved = readFileSync(doctrinePath, 'utf8');

  const checked = await box.inProcess(repo.root, 'spec', 'check');
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
  assert.match(checked.stdout, /DOCTRINE\.md: 13 rows/u, 'lint output names the actual source file and includes inherited rules');
  assert.ok((await specRows(box, repo.root)).some((row) => row.id === 'L1' && row.file === DOCTRINE));
  const view = await box.inProcess(repo.root, 'spec', 'view', '--out', 'doctrine-view.html');
  assert.equal(view.status, 0, `${view.stdout}${view.stderr}`);
  const html = readFileSync(join(repo.root, 'doctrine-view.html'), 'utf8');
  assert.match(html, /<label for="t-practice">Doctrine<\/label>/u);
  assert.match(html, /DOCTRINE\.md/u);

  const state = projectState(repo.root);
  assert.ok(state.practice.some((row) => row.id === 'L1'), 'API v1 retains the established practice field name');
  assert.equal(Object.hasOwn(state, 'doctrine'), false, 'the filename rename does not rename the API field');
  const repeated = await box.inProcess(repo.root, 'init');
  assert.equal(repeated.status, 0, `${repeated.stdout}${repeated.stderr}`);
  assert.equal(readFileSync(doctrinePath, 'utf8'), saved, 'rerunning init preserves repo doctrine rows');
  const guidance = readFileSync(join(repo.root, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /L1 \(repo\)/u, 'generated guidance renders the same local row');
  assert.equal(guidance.split('house rules for agentic development').length - 1, 1, 'guidance glosses doctrine once');
});

test('[D1,D2,A5] legacy init keeps PRACTICE rules and doctor offers a working one-step rename', async function legacyDoctrineFallback() {
  const box = sandbox();
  const repo = await initializedRepo(box, 'legacy-repo', { legacy: true });
  assert.equal(existsSync(join(repo.root, DOCTRINE)), false, 'legacy initialization does not create a competing file');
  assert.equal(readFileSync(join(repo.root, PRACTICE), 'utf8'), LEGACY_RULES, 'legacy content is preserved byte for byte');
  assert.ok((await specRows(box, repo.root)).some((row) => row.id === 'L1' && row.file === PRACTICE));
  const view = await box.inProcess(repo.root, 'spec', 'view', '--out', 'legacy-view.html');
  assert.equal(view.status, 0, `${view.stdout}${view.stderr}`);
  assert.match(readFileSync(join(repo.root, 'legacy-view.html'), 'utf8'), /PRACTICE\.md/u);
  const state = projectState(repo.root);
  assert.ok(state.practice.some((row) => row.id === 'L1'), 'the API still exposes legacy rules as state.practice');

  const untrackedRename = (await doctorProblems(box, repo.root)).find((problem) => problem.code === 'DOCTRINE_LEGACY');
  assert.ok(untrackedRename);
  assert.equal(untrackedRename.next, `mv -- ${PRACTICE} ${DOCTRINE}`, 'an untracked legacy file needs a filesystem rename');
  const moved = runFixtureChild('sh', ['-c', untrackedRename.next], { cwd: repo.root, env: box.env, encoding: 'utf8' });
  assert.equal(moved.status, 0, moved.stderr);
  assert.ok((await specRows(box, repo.root)).some((row) => row.id === 'L1' && row.file === DOCTRINE));
  renameSync(join(repo.root, DOCTRINE), join(repo.root, PRACTICE));

  box.git(repo.root, 'add', '-A');
  box.git(repo.root, 'commit', '-q', '-m', 'chore: initialize legacy doctrine fixture');
  const findings = await doctorProblems(box, repo.root);
  const rename = findings.find((problem) => problem.code === 'DOCTRINE_LEGACY');
  assert.ok(rename, 'doctor identifies the legacy filename');
  assert.equal(rename.next, `git mv -- ${PRACTICE} ${DOCTRINE}`);
  box.git(repo.root, ...rename.next.split(' ').slice(1));
  const after = await doctorProblems(box, repo.root);
  assert.equal(after.some((problem) => problem.code === 'DOCTRINE_LEGACY'), false, 'the suggested rename clears the finding');
  assert.ok((await specRows(box, repo.root)).some((row) => row.id === 'L1' && row.file === DOCTRINE), 'readers keep the same rule after rename');
  assert.ok(projectState(repo.root).practice.some((row) => row.id === 'L1'));
  const kept = readFileSync(join(repo.root, DOCTRINE), 'utf8');
  writeFileSync(join(repo.root, DOCTRINE), kept.replace('- L1 [fact] Keep the legacy rule.\n', ''));
  const erased = await box.inProcess(repo.root, 'spec', 'check');
  assert.equal(erased.status, 1, 'a pending filename rename does not erase the old ids');
  assert.match(erased.stdout, /L1 error:.*ids are permanent/u);
  box.git(repo.root, 'add', '--', DOCTRINE);
  assert.throws(() => box.git(repo.root, 'commit', '-q', '-m', 'docs: erase a legacy doctrine row'), /ids are permanent/u);
  writeFileSync(join(repo.root, DOCTRINE), kept);
  box.git(repo.root, 'add', '--', DOCTRINE);
  box.git(repo.root, 'commit', '-q', '-m', 'docs: rename the legacy doctrine');
  assert.ok((await specRows(box, repo.root)).some((row) => row.id === 'L1'), 'the intact rename commits through its installed hooks');
});

test('[D1,D2,A5] two conventional doctrine files refuse with a named BAD_CONFIG error', async function refuseDuplicateDoctrineNames() {
  const box = sandbox();
  const repo = await initializedRepo(box, 'duplicate-repo');
  writeFileSync(join(repo.root, PRACTICE), LEGACY_RULES);
  const result = await box.inProcess(repo.root, 'spec', 'check', '--json');
  assert.notEqual(result.status, 0);
  const document = JSON.parse(result.stdout);
  assert.equal(document.error.code, 'BAD_CONFIG');
  assert.match(document.error.message, /DOCTRINE\.md/u);
  assert.match(document.error.message, /PRACTICE\.md/u);
  assert.match(document.error.next, /merge their rules/u);
});

test('[D1,D2,A5] explicit custom practice paths remain authoritative beside DOCTRINE.md', async function retainCustomDoctrinePath() {
  const box = sandbox();
  const repo = await initializedRepo(box, 'custom-repo');
  const custom = '# Custom doctrine\n\n## C · Custom\n- C1 [fact] Use the configured custom doctrine file.\n';
  writeFileSync(join(repo.root, 'ways.md'), custom);
  const configPath = join(repo.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, practice: 'ways.md' }, null, 2)}\n`);

  const checked = await box.inProcess(repo.root, 'spec', 'check');
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
  assert.match(checked.stdout, /ways\.md: 13 rows/u);
  const rows = await specRows(box, repo.root);
  assert.ok(rows.some((row) => row.id === 'C1' && row.file === 'ways.md'));
  assert.equal(rows.some((row) => row.id === 'L1'), false, 'custom path remains the configured source');
  assert.ok(projectState(repo.root).practice.some((row) => row.id === 'C1'));
});

/** Make a committed pre-init rename fixture, optionally adding a later collision on main. */
function renamedDoctrineFixture(box, name, { laterCollision = false, commitRename = true } = {}) {
  const root = join(box.dir, name);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const originalSpec = '# Requirements\n\n## G · Goals\n- G1 [draft, aim] Existing requirement.\n';
  const originalPractice = '# Legacy rules\n\n## G · Goals\n- G1 [draft] Existing collision.\n- G2 [draft] Legacy id without a collision.\n';
  writeFileSync(join(root, 'SPEC.md'), originalSpec);
  writeFileSync(join(root, PRACTICE), originalPractice);
  box.git(root, 'add', 'SPEC.md', PRACTICE);
  box.git(root, 'commit', '-q', '-m', 'docs: seed legacy doctrine collision');
  box.git(root, 'mv', PRACTICE, DOCTRINE);
  if (commitRename) box.git(root, 'commit', '-q', '-m', 'docs: rename practice to doctrine');
  if (laterCollision) {
    const updatedSpec = `${originalSpec.trimEnd()}\n- G2 [draft, aim] Added after the doctrine rename.\n`;
    writeFileSync(join(root, 'SPEC.md'), updatedSpec);
    box.git(root, 'add', 'SPEC.md');
    box.git(root, 'commit', '-q', '-m', 'docs: add post-rename collision');
  }
  return root;
}

test('[D4,A5] rename keeps known duplicates while a later collision remains an error', async function renameKeepsKnownDuplicates() {
  const box = sandbox();
  const beforeCollision = renamedDoctrineFixture(box, 'legacy-before-collision');
  const initialized = await box.inProcess(beforeCollision, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const knownOnly = await box.inProcess(beforeCollision, 'spec', 'check');
  assert.equal(knownOnly.status, 0, `${knownOnly.stdout}${knownOnly.stderr}`);
  assert.match(knownOnly.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(knownOnly.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);

  const afterCollision = renamedDoctrineFixture(box, 'legacy-after-collision', { laterCollision: true });
  const laterInitialized = await box.inProcess(afterCollision, 'init');
  assert.equal(laterInitialized.status, 0, `${laterInitialized.stdout}${laterInitialized.stderr}`);
  const later = await box.inProcess(afterCollision, 'spec', 'check');
  assert.equal(later.status, 1, later.stdout);
  assert.match(later.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(later.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
  assert.match(later.stdout, /SPEC\.md:5 G2 error: duplicate id; also appears at DOCTRINE\.md:5/u);
  assert.match(later.stdout, /DOCTRINE\.md:5 G2 error: duplicate id; also appears at SPEC\.md:5/u);
});

test('[D4,A5] canonical collisions stay errors without legacy rename history', async function canonicalCollisionNeedsLegacyHistory() {
  const box = sandbox();
  const root = join(box.dir, 'never-legacy');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'SPEC.md'), '# Requirements\n\n## G · Goals\n- G1 [draft, aim] Existing requirement.\n');
  writeFileSync(join(root, DOCTRINE), '# Doctrine\n\n## G · Goals\n- G1 [draft] Existing collision.\n');
  box.git(root, 'add', 'SPEC.md', DOCTRINE);
  box.git(root, 'commit', '-q', '-m', 'docs: add canonical doctrine collision');
  const initialized = await box.inProcess(root, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const check = await box.inProcess(root, 'spec', 'check');
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stdout, /SPEC\.md:4 G1 error: duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(check.stdout, /DOCTRINE\.md:4 G1 error: duplicate id; also appears at SPEC\.md:4/u);
});

/** Keep both conventional doctrine paths readable at an older pinned revision. */
test('doctrine history reads at a pinned revision [N26]', function doctrineHistoryAtPinnedRevision() {
  const box = sandbox();
  const root = join(box.dir, 'pinned-history');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const first = '# Doctrine\n\n## L · Local\n- L1 [fact] First legacy rule.\n';
  writeFileSync(join(root, PRACTICE), first);
  box.git(root, 'add', PRACTICE);
  box.git(root, 'commit', '-q', '-m', 'docs: add first legacy rule');
  const pinned = box.git(root, 'rev-parse', 'HEAD');

  writeFileSync(join(root, PRACTICE), `${first}- L2 [fact] Second legacy rule.\n`);
  box.git(root, 'add', PRACTICE);
  box.git(root, 'commit', '-q', '-m', 'docs: add second legacy rule');
  const legacyPinned = doctrineHistory(root, PRACTICE, [pinned]);
  assert.deepEqual([...legacyPinned.ids.keys()].sort(), ['L1'], 'the legacy filename honors the requested revision');
  assert.deepEqual([...doctrineHistory(root, PRACTICE).ids.keys()].sort(), ['L1', 'L2'], 'the default still reads current HEAD');

  box.git(root, 'mv', PRACTICE, DOCTRINE);
  box.git(root, 'commit', '-q', '-m', 'docs: rename practice to doctrine');
  writeFileSync(join(root, DOCTRINE), `${readFileSync(join(root, DOCTRINE), 'utf8')}- L3 [fact] Third doctrine rule.\n`);
  box.git(root, 'add', DOCTRINE);
  box.git(root, 'commit', '-q', '-m', 'docs: add third doctrine rule');

  const currentPinned = doctrineHistory(root, DOCTRINE, [pinned]);
  assert.deepEqual([...currentPinned.ids.keys()].sort(), ['L1'], 'the current filename recovers the pinned legacy history without later rows');
  assert.deepEqual([...doctrineHistory(root, DOCTRINE).ids.keys()].sort(), ['L1', 'L2', 'L3'], 'the current filename default includes history through the rename');
});


test('[D4,A5] a staged rename keeps known duplicates before its rename commit', async function stagedRenameKeepsKnownDuplicates() {
  const box = sandbox();
  const root = renamedDoctrineFixture(box, 'staged-legacy-rename', { commitRename: false });
  const initialized = await box.inProcess(root, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const check = await box.inProcess(root, 'spec', 'check');
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(check.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
});

test('[D4,A5] spec check in a fresh detached CI clone reads its own commit', async function detachedCiCloneUsesCheckedCommit() {
  const box = sandbox();
  for (const scenario of [
    { name: 'ci-known', laterCollision: false },
    { name: 'ci-later', laterCollision: true },
  ]) {
    const source = renamedDoctrineFixture(box, `${scenario.name}-source`, { laterCollision: scenario.laterCollision });
    const initialized = await box.inProcess(source, 'init');
    assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
    box.git(source, 'add', '-A');
    box.git(source, 'commit', '-q', '-m', 'chore: commit detached CI fixture configuration');
    box.git(source, 'tag', scenario.name);

    const clone = join(box.dir, `${scenario.name}-clone`);
    box.git(box.dir, 'clone', '--quiet', '--no-local', '--no-checkout', '--', source, clone);
    box.git(clone, 'checkout', '--quiet', '--detach', scenario.name);
    const localTrunk = spawnSync('git', ['config', '--local', '--get', 'pullboard.trunk'], { cwd: clone, env: box.env, encoding: 'utf8' });
    assert.equal(localTrunk.status, 1, 'the detached CI clone has no recorded trunk configuration');

    const checked = await box.inProcess(clone, 'spec', 'check');
    assert.match(checked.stdout, /^collision baseline default: detached HEAD$/mu, 'the check announces the detached default ref');
    assert.match(checked.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
    assert.match(checked.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
    if (scenario.laterCollision) {
      assert.equal(checked.status, 1, checked.stdout);
      assert.match(checked.stdout, /SPEC\.md:5 G2 error: duplicate id; also appears at DOCTRINE\.md:5/u);
      assert.match(checked.stdout, /DOCTRINE\.md:5 G2 error: duplicate id; also appears at SPEC\.md:5/u);
    } else {
      assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /SPEC\.md: \d+ rows, 0 errors/u);
      assert.match(checked.stdout, /DOCTRINE\.md: \d+ rows, 0 errors/u);
    }
  }
});

test('[D4,A5] detached verifier clones use a recorded trunk or their checked commit', async function verifierCloneRetainsTrunkBaseline() {
  const box = sandbox();
  const source = renamedDoctrineFixture(box, 'detached-source');
  const initialized = await box.inProcess(source, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  box.git(source, 'add', '-A');
  box.git(source, 'commit', '-q', '-m', 'chore: initialize detached spec fixture');
  assert.equal(box.git(source, 'config', '--local', '--get', 'pullboard.trunk'), 'refs/heads/main', 'initialization records the actual source trunk');
  const commit = box.git(source, 'rev-parse', 'HEAD');
  const item = { item_id: 324, item_claim_head: commit, item_commit: commit,
    item_frozen: JSON.stringify({ check: `${shellWord(process.execPath)} ${shellWord(BIN)} spec check` }) };

  const checked = checkAtCommit(source, item);
  assert.equal(checked.state, 'pass', `${checked.stage}\n${checked.output}`);
  assert.match(checked.output, /SPEC\.md: \d+ rows, 0 errors, \d+ warnings/u);
  assert.match(checked.output, /DOCTRINE\.md: \d+ rows, 0 errors, \d+ warnings/u);
  assert.match(checked.output, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(checked.output, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);

  const attached = await box.inProcess(source, 'spec', 'check');
  assert.equal(attached.status, 0, `${attached.stdout}${attached.stderr}`);
  const attachedRows = await specRows(box, source);
  const jsonFile = join(box.dir, 'verifier-spec-rows.json');
  const json = checkAtCommit(source, { ...item, item_frozen: JSON.stringify({ check: `${shellWord(process.execPath)} ${shellWord(BIN)} spec --json > ${shellWord(jsonFile)}` }) });
  assert.equal(json.state, 'pass', `${json.stage}\n${json.output}`);
  const rows = JSON.parse(readFileSync(jsonFile, 'utf8')).rows;
  assert.deepEqual(rows, attachedRows, 'the production verifier clone reports the same rows as attached main');
  assert.ok(rows.some(row => row.file === 'SPEC.md' && row.id === 'G1'));
  assert.ok(rows.some(row => row.file === DOCTRINE && row.id === 'G1'));

  const withoutTrunk = renamedDoctrineFixture(box, 'detached-source-without-trunk');
  const noTrunkInit = await box.inProcess(withoutTrunk, 'init');
  assert.equal(noTrunkInit.status, 0, `${noTrunkInit.stdout}${noTrunkInit.stderr}`);
  box.git(withoutTrunk, 'add', '-A');
  box.git(withoutTrunk, 'commit', '-q', '-m', 'chore: initialize no-trunk spec fixture');
  const noTrunkCommit = box.git(withoutTrunk, 'rev-parse', 'HEAD');
  // Init and the installed commit hook both remember the attached trunk; remove it only after them.
  box.git(withoutTrunk, 'config', '--local', '--unset-all', 'pullboard.trunk');
  assert.equal(runFixtureChild('git', ['config', '--local', '--get', 'pullboard.trunk'], {
    cwd: withoutTrunk, env: box.env,
  }).status, 1, 'the source actually has no retained trunk');
  const attachedWithoutTrunk = await box.inProcess(withoutTrunk, 'spec', 'check');
  assert.equal(attachedWithoutTrunk.status, 0, `${attachedWithoutTrunk.stdout}${attachedWithoutTrunk.stderr}`);
  assert.doesNotMatch(attachedWithoutTrunk.stdout, /collision baseline default: detached HEAD/u, 'an attached checkout keeps using its own branch');
  box.git(withoutTrunk, 'config', '--local', '--unset-all', 'pullboard.trunk');
  assert.equal(spawnSync('git', ['config', '--local', '--get', 'pullboard.trunk'], {
    cwd: withoutTrunk, env: box.env,
  }).status, 1, 'the source remains without a retained trunk for the detached verifier');
  const detachedWithoutTrunk = checkAtCommit(withoutTrunk, { ...item, item_claim_head: noTrunkCommit, item_commit: noTrunkCommit });
  assert.equal(detachedWithoutTrunk.state, 'pass', `${detachedWithoutTrunk.stage}\n${detachedWithoutTrunk.output}`);
  assert.match(detachedWithoutTrunk.output, /^collision baseline default: detached HEAD$/mu);
  assert.match(detachedWithoutTrunk.output, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(detachedWithoutTrunk.output, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
});

test('[D4,A5] verify in a detached checkout reads the trunk baseline for a doctrine frozen check', async function verifyDoctrineFrozenCheck() {
  const box = sandbox();
  const source = renamedDoctrineFixture(box, 'verify-doctrine-source');
  const initialized = await box.inProcess(source, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const configPath = join(source, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, gate: 'true', verify: 'coordinator',
    lanes: { web: { owns: ['web/'], specs: [] } }, shared: [] }, null, 2) + '\n');
  box.git(source, 'add', '-A');
  box.git(source, 'commit', '-q', '-m', 'chore: initialize doctrine verification fixture');
  const check = `out=$(${shellWord(process.execPath)} ${shellWord(BIN)} spec check 2>&1) && printf '%s\\n' "$out" | grep -Eq 'DOCTRINE[.]md: .*0 errors'`;
  const added = await fixtureAdd(box.inProcess, source, 'web', 'Doctrine review fixture', '--criterion', 'The frozen doctrine check passes in the verifier clone.', '--check', check, '--json');
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const id = JSON.parse(added.stdout).item.item_id;
  const builder = join(box.dir, 'verify-doctrine-builder');
  box.git(source, 'worktree', 'add', '-q', '-b', 'web/doctrine-review', builder);
  assert.equal((await fixtureJoin(box.inProcess, builder, 'web', '--route', 'strong')).status, 0);
  // This doctrine check already passes on main by design; the person accepts it so the new board's hold lifts.
  assert.equal((await box.inProcess(source, 'check', 'accept', String(id))).status, 0);
  assert.equal((await box.inProcess(builder, 'claim', String(id))).status, 0);
  mkdirSync(join(builder, 'web'));
  writeFileSync(join(builder, 'web/candidate.txt'), 'doctrine verification fixture\n');
  box.git(builder, 'add', 'web/candidate.txt');
  box.git(builder, 'commit', '-q', '-m', 'feat(web): build doctrine verification fixture [G1]');
  const submitted = await box.inProcess(builder, 'submit', String(id), '--json');
  assert.equal(submitted.status, 0, `${submitted.stdout}${submitted.stderr}`);
  const commit = JSON.parse(submitted.stdout).commit;
  box.git(source, 'switch', '-q', '--detach', commit);
  const accepted = await box.inProcess(source, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The exact private frozen doctrine check passed.', '--json');
  assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.check, 'green', 'the real verifier records that the frozen doctrine check ran and passed');
  const shown = await box.inProcess(source, 'show', String(id), '--json');
  assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  assert.equal(JSON.parse(shown.stdout).item_status, 'verified');
});
