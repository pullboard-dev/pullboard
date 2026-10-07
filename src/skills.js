/**
 * Role guides (N6): how an agent decomposes an ask with the person, walks them through sign-off,
 * reviews the spec against the client, and verifies another agent's work. One source per role,
 * three ways in: Claude Code skills that init installs, `pullboard prompt <role>` for any other
 * agent, and a repo's own override in `.pullboard/prompts/<role>.md`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from './refused.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

/**
 * Each role and the skill that carries it.
 */
export const ROLES = {
  decompose: 'pullboard-decompose',
  plan: 'pullboard-plan',
  signoff: 'pullboard-signoff',
  review: 'pullboard-spec-review',
  verify: 'pullboard-verify',
  run: 'pullboard-run',
};

/**
 * The skill file shipped with this package for a role.
 *
 * @param {string} role
 * @returns {string}
 */
function shippedSkill(role) {
  const name = ROLES[role];
  if (!name) {
    throw new Refused('NO_ROLE', `no role "${role}"; roles: ${Object.keys(ROLES).join(', ')}`);
  }
  return readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
}

/**
 * A skill's text without its front matter, for agents that read plain instructions.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutFrontMatter(text) {
  return text.startsWith('---\n') ? text.slice(text.indexOf('\n---\n', 4) + 5).replace(/^\n+/, '') : text;
}

/**
 * The guide for a role: the repo's own override when it has one, the shipped guide otherwise.
 *
 * @param {string} root
 * @param {string} role
 * @returns {string}
 */
export function promptFor(root, role) {
  const override = join(root, '.pullboard', 'prompts', `${role}.md`);
  if (ROLES[role] && existsSync(override)) return readFileSync(override, 'utf8');
  return withoutFrontMatter(shippedSkill(role));
}

/**
 * Install the role guides as Claude Code skills under `.claude/skills/`, never replacing a file
 * that is already there (I2).
 *
 * @param {string} root
 * @returns {string[]} What happened.
 */
export function installSkills(root) {
  const written = [];
  for (const [role, name] of Object.entries(ROLES)) {
    const file = join(root, '.claude', 'skills', name, 'SKILL.md');
    if (existsSync(file)) continue;
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true });
    writeFileSync(file, shippedSkill(role));
    written.push(name);
  }
  return written.length
    ? [`wrote Claude Code skills: ${written.join(', ')}`]
    : ['kept the Claude Code skills'];
}
