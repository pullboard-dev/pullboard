/** Canonical doctrine naming keeps legacy repos and the stable state API readable [D1,D2,A5]. */
import assert from 'node:assert/strict';
import {
  runFixtureChild as spawnSync,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectState } from '../../src/io/view.js';
import { doctrineHistory } from '../../../../packages/doctrine/index.js';
import {
  DOCTRINE,
  PRACTICE,
  renamedDoctrineFixture,
  sandbox,
  specRows,
} from '../../tests/fixtures/doctrine-name.js';

const LEGACY_RULES = '# Legacy doctrine\n\n## L · Local\n- L1 [fact] Keep the legacy rule.\n';
const LOCAL_RULE = '\n## L · Local\n- L1 [fact] Keep this repo rule.\n';

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
  // The approved agents block (#3933) points at the doctrine file instead of rendering its rows, so one repo rule never shows twice.
  assert.match(guidance, /<!-- pullboard:start -->/u, 'init writes the approved agents block');
  assert.doesNotMatch(guidance, /L1 \(repo\)/u, 'the approved agents block does not copy repo doctrine rows');
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
