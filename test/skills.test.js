/** Shipped Claude skills can be diagnosed and refreshed without overwriting local edits [I2]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';
import { ROLES, SHIPPED_SKILL_DIGESTS } from '../src/skills.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const RELEASES = ['0.5.0', '0.6.0', '0.6.1', '0.7.0', '0.8.0', '0.8.1', '0.8.2', '0.8.3', '0.8.4'];
const LEGACY_SNIPPETS = {
  decompose: ['SPEC.md and DOCTRINE.md (or PRACTICE.md when it is the only legacy file) if they exist.', 'SPEC.md and PRACTICE.md if they exist.'],
  plan: ['DOCTRINE.md (or PRACTICE.md when it is the only legacy file) and `pullboard lanes`.', 'PRACTICE.md and `pullboard lanes`.'],
  review: ['SPEC.md, DOCTRINE.md (or PRACTICE.md when it is the only legacy file) and the README.', 'SPEC.md, PRACTICE.md and the README.'],
  verify: ['approved rows of DOCTRINE.md (or PRACTICE.md when it is the only legacy file) that the change touches.', 'approved rows of PRACTICE.md that the change touches.'],
};
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Build an isolated real Git repo and board for a CLI behavior. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-skills-'));
  TEMP_DIRS.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    PULLBOARD_HOME: join(dir, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Skills Test',
    GIT_AUTHOR_EMAIL: 'skills@example.invalid',
    GIT_COMMITTER_NAME: 'Skills Test',
    GIT_COMMITTER_EMAIL: 'skills@example.invalid',
  };
  /** Run Git with this fixture's private identity and home. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env, encoding: 'utf8' });
  /** Run the actual Pullboard CLI in the initialized fixture repository. */
  const run = (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: {} }, null, 2));
  writeFileSync(join(root, 'SPEC.md'), '# Skills fixture\n');
  writeFileSync(join(root, 'DOCTRINE.md'), '# Doctrine fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize skills fixture');
  assert.equal(run('status').status, 0, 'the fixture opens a real local board');
  return { dir, root, env, git, run };
}

/** Return the exact legacy file bytes for the four skills changed in 0.8.1. */
function legacySkill(role) {
  const name = ROLES[role];
  const file = resolve(import.meta.dirname, `../skills/${name}/SKILL.md`);
  const current = readFileSync(file, 'utf8');
  const [currentSnippet, oldSnippet] = LEGACY_SNIPPETS[role];
  assert.ok(current.includes(currentSnippet), `${role} ships the doctrine migration phrase`);
  return current.replace(currentSnippet, oldSnippet);
}

/** Hash the file bytes using the release catalog's SHA-256 contract. */
function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Write role files after normal setup so the fixture models an earlier installation. */
function installText(box, role, text) {
  const name = ROLES[role];
  const file = join(box.root, '.claude', 'skills', name, 'SKILL.md');
  mkdirSync(join(box.root, '.claude', 'skills', name), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Parse one JSON command result and assert the CLI succeeded. */
function json(box, ...args) {
  const result = box.run(...args, '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('doctor names a skill older than this Pullboard [I2]', () => {
  const box = project();
  const expectedOld = {
    decompose: '1fc167b251f9887e097dbef73e190bc13ad164129c1adcf6e8a226620428c3f8',
    plan: '3f4c4ad64e2b2993b081f1a87a32ff0c649dd72954d79aadaf8ef94ce655a212',
    review: '7171d937b30dc711386ff07222656530164e071c4704804f8a95434d9f86407d',
    verify: '99278a7596f50c25b9f1e4764faa58ea48fd4450af95a30992f7421dafac3351',
  };
  for (const [role, shippedDigest] of Object.entries(expectedOld)) {
    const oldText = legacySkill(role);
    assert.equal(digest(oldText), shippedDigest, `${role} fixture matches exact shipped bytes`);
    assert.ok(SHIPPED_SKILL_DIGESTS[role][shippedDigest].includes('0.8.0'));
    installText(box, role, oldText);
  }
  for (const digests of Object.values(SHIPPED_SKILL_DIGESTS)) {
    assert.deepEqual([...new Set(Object.values(digests).flat())].sort(), RELEASES, 'catalog records each tagged shipped version');
  }
  const doctor = box.run('doctor', '--json');
  assert.equal(doctor.status, 1, doctor.stdout);
  assert.equal(doctor.stderr, '');
  const result = JSON.parse(doctor.stdout);
  const skillFindings = result.problems.filter((problem) => problem.code.startsWith('SKILL_'));
  assert.equal(skillFindings.length, 4);
  for (const [index, role] of ['decompose', 'plan', 'review', 'verify'].entries()) {
    const problem = skillFindings[index];
    assert.equal(problem.code, 'SKILL_OUTDATED');
    assert.ok(problem.message.includes(ROLES[role]));
    assert.match(problem.message, /Pullboard 0\.8\.0/u);
    assert.match(problem.message, /missing changes: replace/u);
    assert.equal(problem.next, 'run pullboard skills --update');
  }
});

test('skills --update refreshes an unmodified old skill [I2]', () => {
  const box = project();
  const oldRoles = ['decompose', 'plan', 'review', 'verify'];
  const files = new Map(oldRoles.map((role) => [role, installText(box, role, legacySkill(role))]));
  const result = json(box, 'skills', '--update');
  assert.deepEqual(result.updated, oldRoles.map((role) => `.claude/skills/${ROLES[role]}/SKILL.md`));
  assert.deepEqual(result.customized, []);
  for (const [role, file] of files) {
    const current = readFileSync(resolve(import.meta.dirname, `../skills/${ROLES[role]}/SKILL.md`), 'utf8');
    assert.equal(readFileSync(file, 'utf8'), current, `${role} now matches current shipped bytes`);
  }
});

test('skills --update never replaces an edited skill [I2]', () => {
  const box = project();
  const edited = `${legacySkill('decompose')}\nLocal instruction: keep this repo's extra review step.\n`;
  const file = installText(box, 'decompose', edited);
  const before = readFileSync(file);
  const doctor = box.run('doctor', '--json');
  assert.equal(doctor.status, 1, doctor.stdout);
  assert.equal(doctor.stderr, '');
  const skillFinding = JSON.parse(doctor.stdout).problems.find((problem) => problem.code.startsWith('SKILL_'));
  assert.equal(skillFinding.code, 'SKILL_EDITED_OUTDATED');
  assert.match(skillFinding.message, /closest to the Pullboard 0\.8\.0 skill, edited by you/u);
  assert.match(skillFinding.message, /replace .*PRACTICE\.md.*DOCTRINE\.md/u);
  const update = json(box, 'skills', '--update');
  assert.deepEqual(readFileSync(file), before, 'an edited skill is never replaced');
  assert.deepEqual(update.customized, [{
    path: '.claude/skills/pullboard-decompose/SKILL.md',
    missing: [expectMissingChange()],
  }]);
});

/** Keep the CLI's displayed action stable without copying a second formatter into the assertion. */
function expectMissingChange() {
  return 'replace “SPEC.md and PRACTICE.md if they exist.” with “SPEC.md and DOCTRINE.md (or PRACTICE.md when it is the only legacy file) if they exist.”';
}
