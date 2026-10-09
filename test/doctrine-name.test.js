/** Canonical doctrine naming keeps legacy repos and the stable state API readable [D1,D2,A5]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { projectState } from '../src/serve.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
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
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  }
  /** Run one real CLI command and keep stdout, stderr and status available to assertions. */
  function run(cwd, ...args) {
    return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', timeout: 20_000 });
  }
  return { dir, env, git, run };
}

/** Initialize a throwaway repo, optionally with the historical filename already present. */
function initializedRepo(box, name, { legacy = false } = {}) {
  const root = join(box.dir, name);
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  if (legacy) writeFileSync(join(root, PRACTICE), LEGACY_RULES);
  const result = box.run(root, 'init');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { ...box, root, init: result };
}

/** Append one valid local rule under its own doctrine section. */
function addLocalRule(root, file = DOCTRINE) {
  writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8').trimEnd()}${LOCAL_RULE}`);
}

/** Run spec JSON and return its rows after checking the CLI result. */
function specRows(box, root) {
  const result = box.run(root, 'spec', '--json');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).rows;
}

/** Return doctor findings from the versioned JSON output. */
function doctorProblems(box, root) {
  const result = box.run(root, 'doctor', '--json');
  assert.ok([0, 1].includes(result.status), `${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout).problems;
}

test('[D1,D2,A5] init chooses DOCTRINE and preserves its rows through checks, JSON, view and rerun', function canonicalDoctrineFile() {
  const box = sandbox();
  const repo = initializedRepo(box, 'new-repo');
  const doctrinePath = join(repo.root, DOCTRINE);
  assert.equal(existsSync(doctrinePath), true, 'a fresh init writes the canonical doctrine file');
  assert.equal(existsSync(join(repo.root, PRACTICE)), false, 'a fresh init does not create the legacy filename');
  const config = JSON.parse(readFileSync(join(repo.root, 'pullboard.json'), 'utf8'));
  assert.equal(config.practice, DOCTRINE, 'the existing config field points at the canonical file');
  const help = box.run(repo.root, 'help', '--all');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /doctrine \(house rules for agentic development\)/u);
  addLocalRule(repo.root);
  const saved = readFileSync(doctrinePath, 'utf8');

  const checked = box.run(repo.root, 'spec', 'check');
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
  assert.match(checked.stdout, /DOCTRINE\.md: 13 rows/u, 'lint output names the actual source file and includes inherited rules');
  assert.ok(specRows(box, repo.root).some((row) => row.id === 'L1' && row.file === DOCTRINE));
  const view = box.run(repo.root, 'spec', 'view', '--out', 'doctrine-view.html');
  assert.equal(view.status, 0, `${view.stdout}${view.stderr}`);
  const html = readFileSync(join(repo.root, 'doctrine-view.html'), 'utf8');
  assert.match(html, /<label for="t-practice">Doctrine<\/label>/u);
  assert.match(html, /DOCTRINE\.md/u);

  const state = projectState(repo.root);
  assert.ok(state.practice.some((row) => row.id === 'L1'), 'API v1 retains the established practice field name');
  assert.equal(Object.hasOwn(state, 'doctrine'), false, 'the filename rename does not rename the API field');
  const repeated = box.run(repo.root, 'init');
  assert.equal(repeated.status, 0, `${repeated.stdout}${repeated.stderr}`);
  assert.equal(readFileSync(doctrinePath, 'utf8'), saved, 'rerunning init preserves repo doctrine rows');
  const guidance = readFileSync(join(repo.root, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /L1 \(repo\)/u, 'generated guidance renders the same local row');
  assert.equal(guidance.split('house rules for agentic development').length - 1, 1, 'guidance glosses doctrine once');
});

test('[D1,D2,A5] legacy init keeps PRACTICE rules and doctor offers a working one-step rename', function legacyDoctrineFallback() {
  const box = sandbox();
  const repo = initializedRepo(box, 'legacy-repo', { legacy: true });
  assert.equal(existsSync(join(repo.root, DOCTRINE)), false, 'legacy initialization does not create a competing file');
  assert.equal(readFileSync(join(repo.root, PRACTICE), 'utf8'), LEGACY_RULES, 'legacy content is preserved byte for byte');
  assert.ok(specRows(box, repo.root).some((row) => row.id === 'L1' && row.file === PRACTICE));
  const view = box.run(repo.root, 'spec', 'view', '--out', 'legacy-view.html');
  assert.equal(view.status, 0, `${view.stdout}${view.stderr}`);
  assert.match(readFileSync(join(repo.root, 'legacy-view.html'), 'utf8'), /PRACTICE\.md/u);
  const state = projectState(repo.root);
  assert.ok(state.practice.some((row) => row.id === 'L1'), 'the API still exposes legacy rules as state.practice');

  const untrackedRename = doctorProblems(box, repo.root).find((problem) => problem.code === 'DOCTRINE_LEGACY');
  assert.ok(untrackedRename);
  assert.equal(untrackedRename.next, `mv -- ${PRACTICE} ${DOCTRINE}`, 'an untracked legacy file needs a filesystem rename');
  const moved = spawnSync('sh', ['-c', untrackedRename.next], { cwd: repo.root, env: box.env, encoding: 'utf8' });
  assert.equal(moved.status, 0, moved.stderr);
  assert.ok(specRows(box, repo.root).some((row) => row.id === 'L1' && row.file === DOCTRINE));
  renameSync(join(repo.root, DOCTRINE), join(repo.root, PRACTICE));

  box.git(repo.root, 'add', '-A');
  box.git(repo.root, 'commit', '-q', '-m', 'chore: initialize legacy doctrine fixture');
  const findings = doctorProblems(box, repo.root);
  const rename = findings.find((problem) => problem.code === 'DOCTRINE_LEGACY');
  assert.ok(rename, 'doctor identifies the legacy filename');
  assert.equal(rename.next, `git mv -- ${PRACTICE} ${DOCTRINE}`);
  box.git(repo.root, ...rename.next.split(' ').slice(1));
  const after = doctorProblems(box, repo.root);
  assert.equal(after.some((problem) => problem.code === 'DOCTRINE_LEGACY'), false, 'the suggested rename clears the finding');
  assert.ok(specRows(box, repo.root).some((row) => row.id === 'L1' && row.file === DOCTRINE), 'readers keep the same rule after rename');
  assert.ok(projectState(repo.root).practice.some((row) => row.id === 'L1'));
  const kept = readFileSync(join(repo.root, DOCTRINE), 'utf8');
  writeFileSync(join(repo.root, DOCTRINE), kept.replace('- L1 [fact] Keep the legacy rule.\n', ''));
  const erased = box.run(repo.root, 'spec', 'check');
  assert.equal(erased.status, 1, 'a pending filename rename does not erase the old ids');
  assert.match(erased.stdout, /L1 error:.*ids are permanent/u);
  box.git(repo.root, 'add', '--', DOCTRINE);
  assert.throws(() => box.git(repo.root, 'commit', '-q', '-m', 'docs: erase a legacy doctrine row'), /ids are permanent/u);
  writeFileSync(join(repo.root, DOCTRINE), kept);
  box.git(repo.root, 'add', '--', DOCTRINE);
  box.git(repo.root, 'commit', '-q', '-m', 'docs: rename the legacy doctrine');
  assert.ok(specRows(box, repo.root).some((row) => row.id === 'L1'), 'the intact rename commits through its installed hooks');
});

test('[D1,D2,A5] two conventional doctrine files refuse with a named BAD_CONFIG error', function refuseDuplicateDoctrineNames() {
  const box = sandbox();
  const repo = initializedRepo(box, 'duplicate-repo');
  writeFileSync(join(repo.root, PRACTICE), LEGACY_RULES);
  const result = box.run(repo.root, 'spec', 'check', '--json');
  assert.notEqual(result.status, 0);
  const document = JSON.parse(result.stdout);
  assert.equal(document.error.code, 'BAD_CONFIG');
  assert.match(document.error.message, /DOCTRINE\.md/u);
  assert.match(document.error.message, /PRACTICE\.md/u);
  assert.match(document.error.next, /merge their rules/u);
});

test('[D1,D2,A5] explicit custom practice paths remain authoritative beside DOCTRINE.md', function retainCustomDoctrinePath() {
  const box = sandbox();
  const repo = initializedRepo(box, 'custom-repo');
  const custom = '# Custom doctrine\n\n## C · Custom\n- C1 [fact] Use the configured custom doctrine file.\n';
  writeFileSync(join(repo.root, 'ways.md'), custom);
  const configPath = join(repo.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, practice: 'ways.md' }, null, 2)}\n`);

  const checked = box.run(repo.root, 'spec', 'check');
  assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
  assert.match(checked.stdout, /ways\.md: 13 rows/u);
  const rows = specRows(box, repo.root);
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

test('[D4,A5] rename keeps known duplicates while a later collision remains an error', function renameKeepsKnownDuplicates() {
  const box = sandbox();
  const beforeCollision = renamedDoctrineFixture(box, 'legacy-before-collision');
  const initialized = box.run(beforeCollision, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const knownOnly = box.run(beforeCollision, 'spec', 'check');
  assert.equal(knownOnly.status, 0, `${knownOnly.stdout}${knownOnly.stderr}`);
  assert.match(knownOnly.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(knownOnly.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);

  const afterCollision = renamedDoctrineFixture(box, 'legacy-after-collision', { laterCollision: true });
  const laterInitialized = box.run(afterCollision, 'init');
  assert.equal(laterInitialized.status, 0, `${laterInitialized.stdout}${laterInitialized.stderr}`);
  const later = box.run(afterCollision, 'spec', 'check');
  assert.equal(later.status, 1, later.stdout);
  assert.match(later.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(later.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
  assert.match(later.stdout, /SPEC\.md:5 G2 error: duplicate id; also appears at DOCTRINE\.md:5/u);
  assert.match(later.stdout, /DOCTRINE\.md:5 G2 error: duplicate id; also appears at SPEC\.md:5/u);
});

test('[D4,A5] canonical collisions stay errors without legacy rename history', function canonicalCollisionNeedsLegacyHistory() {
  const box = sandbox();
  const root = join(box.dir, 'never-legacy');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'SPEC.md'), '# Requirements\n\n## G · Goals\n- G1 [draft, aim] Existing requirement.\n');
  writeFileSync(join(root, DOCTRINE), '# Doctrine\n\n## G · Goals\n- G1 [draft] Existing collision.\n');
  box.git(root, 'add', 'SPEC.md', DOCTRINE);
  box.git(root, 'commit', '-q', '-m', 'docs: add canonical doctrine collision');
  const initialized = box.run(root, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const check = box.run(root, 'spec', 'check');
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stdout, /SPEC\.md:4 G1 error: duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(check.stdout, /DOCTRINE\.md:4 G1 error: duplicate id; also appears at SPEC\.md:4/u);
});


test('[D4,A5] a staged rename keeps known duplicates before its rename commit', function stagedRenameKeepsKnownDuplicates() {
  const box = sandbox();
  const root = renamedDoctrineFixture(box, 'staged-legacy-rename', { commitRename: false });
  const initialized = box.run(root, 'init');
  assert.equal(initialized.status, 0, `${initialized.stdout}${initialized.stderr}`);
  const check = box.run(root, 'spec', 'check');
  assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  assert.match(check.stdout, /SPEC\.md:4 G1 warning: known duplicate id; also appears at DOCTRINE\.md:4/u);
  assert.match(check.stdout, /DOCTRINE\.md:4 G1 warning: known duplicate id; also appears at SPEC\.md:4/u);
});
