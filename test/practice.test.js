/**
 * The house rules (S6) and the role guides (N6): the standard PRACTICE.md is a valid spec of its own,
 * and every role guide prints, with a repo's own override taking precedence.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROLES, installSkills, promptFor, withoutFrontMatter } from '../src/skills.js';
import { lintSpec, parseSpec } from '../src/spec.js';
import { standardDoctrine } from '../src/doctrine.js';
import { agentsBlock, practiceTemplate } from '../src/templates.js';

test('the standard practice lints clean, and every approved must-row names its enforcer [S6]', () => {
  const practice = parseSpec(practiceTemplate());
  assert.deepEqual(lintSpec(practice), []);
  assert.equal(practice.rows.length, 0, 'the repo starter no longer copies inherited rules [D4]');
  assert.equal(practice.sections.length, 6);
  assert.equal(practice.intro.filter(line => line === 'Inherits Pullboard standard doctrine version 1.').length, 1);
  const standard = standardDoctrine();
  assert.deepEqual(lintSpec(standard), []);
  const approvedMusts = standard.rows.filter((row) => row.status === 'approved' && row.tier === 'must');
  assert.ok(approvedMusts.length >= 8);
  assert.ok(approvedMusts.every((row) => row.gate));
});

test('the run guide takes one agent through the whole team, and init installs it beside the others [N31]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-run-'));
  try {
    const guide = promptFor(root, 'run');
    assert.ok(guide.startsWith('# Run the team'));
    for (const step of [
      'pullboard resume',
      'pullboard-decompose',
      'Only the person approves a row',
      'pullboard-plan',
      'pullboard worktree <lane>',
      'pullboard worktree review',
      'pullboard-verify',
      'git merge --no-edit',
      'pullboard merged',
      'not yet verified',
      'never by you',
      'Ask, never guess',
    ]) {
      assert.ok(guide.includes(step), `the run guide says: ${step}`);
    }
    assert.match(guide, /\*\*Build[^\n]*A worktree starts from the last commit, so first commit what init wrote, the spec and the lanes/, 'the build step commits the setup before the first worktree');
    assert.match(installSkills(root)[0], /pullboard-run/);
    assert.ok(existsSync(join(root, '.claude', 'skills', 'pullboard-run', 'SKILL.md')), 'init installs it as a skill');
    assert.match(agentsBlock(), /pullboard prompt run/, 'AGENTS.md names it');
    assert.match(agentsBlock(), /pullboard-run skill/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every role prints its guide without front matter [N6]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-prompt-'));
  try {
    for (const role of Object.keys(ROLES)) {
      const text = promptFor(root, role);
      assert.ok(text.startsWith('# '), `${role} starts with its heading`);
      assert.ok(!text.includes('description:'), `${role} has no front matter`);
    }
    assert.throws(() => promptFor(root, 'nope'), /NO_ROLE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo's own guide overrides the shipped one [N6]", () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-prompt-'));
  try {
    mkdirSync(join(root, '.pullboard', 'prompts'), { recursive: true });
    writeFileSync(join(root, '.pullboard', 'prompts', 'verify.md'), '# Our verify\n');
    assert.equal(promptFor(root, 'verify'), '# Our verify\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skills install once and are never overwritten [I2]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-skills-'));
  try {
    assert.match(installSkills(root)[0], /wrote Claude Code skills: pullboard-decompose/);
    const file = join(root, '.claude', 'skills', 'pullboard-verify', 'SKILL.md');
    writeFileSync(file, 'mine');
    assert.deepEqual(installSkills(root), ['kept the Claude Code skills']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(withoutFrontMatter('---\nname: x\n---\n\n# Body\n'), '# Body\n');
});

test('the plan guide keeps git with the builder, routes for the fleet, and reads the conventions [N6]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-prompt-'));
  try {
    const plan = promptFor(root, 'plan');
    assert.doesNotMatch(plan, /no git commands/);
    assert.match(plan, /Builders commit and submit their own work, so a brief never forbids git/);
    assert.match(plan, /Route for the builders who will join\. An item routed above every builder's tier is never built/);
    assert.match(plan, /the module system \(`"type"` in package\.json\), the test runner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
