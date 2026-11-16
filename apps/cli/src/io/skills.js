/** @pullboard-test-input skills/pullboard-decompose/SKILL.md skills/pullboard-plan/SKILL.md skills/pullboard-run/SKILL.md skills/pullboard-signoff/SKILL.md skills/pullboard-spec-review/SKILL.md skills/pullboard-triage/SKILL.md skills/pullboard-verify/SKILL.md package.json */
/**
 * Role guides (N6): how an agent decomposes an ask with the person, walks them through sign-off,
 * reviews the spec against the client, and verifies another agent's work. One source per role,
 * three ways in: Claude Code skills that init installs, `pullboard prompt <role>` for any other
 * agent, and a repo's own override in `.pullboard/prompts/<role>.md`.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWorkerSkill } from '../../../../packages/config/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

const SKILL_VERSIONS = [
  '0.5.0', '0.6.0', '0.6.1', '0.7.0', '0.8.0', '0.8.1', '0.8.2', '0.8.3', '0.8.4',
];

/** Every digest shipped for each Claude role, grouped only when releases shipped identical bytes. */
export const SHIPPED_SKILL_DIGESTS = Object.freeze({
  decompose: Object.freeze({
    '1fc167b251f9887e097dbef73e190bc13ad164129c1adcf6e8a226620428c3f8': Object.freeze(SKILL_VERSIONS.slice(0, 5)),
    '5fe4e52c4759579ff0a05fcc5f973b459068fdbf9a6e3dc19d141ce7efe4c90b': Object.freeze(SKILL_VERSIONS.slice(5)),
  }),
  plan: Object.freeze({
    '3f4c4ad64e2b2993b081f1a87a32ff0c649dd72954d79aadaf8ef94ce655a212': Object.freeze(SKILL_VERSIONS.slice(0, 5)),
    'b433637ac6e85dd3b5b30c3a82404a6ba3de28d3525d63dd184e086a9af64214': Object.freeze(SKILL_VERSIONS.slice(5)),
  }),
  signoff: Object.freeze({
    '892d4a635dc59ec175152da7ee9e9d69bb42a54592ffdb561c4c10c435ca0e13': Object.freeze(SKILL_VERSIONS),
  }),
  review: Object.freeze({
    '7171d937b30dc711386ff07222656530164e071c4704804f8a95434d9f86407d': Object.freeze(SKILL_VERSIONS.slice(0, 5)),
    '0d141e40eddaa4dbb9124e7abd0ae5fbb154d0ea256505ab79e094c62ae91667': Object.freeze(SKILL_VERSIONS.slice(5)),
  }),
  verify: Object.freeze({
    '99278a7596f50c25b9f1e4764faa58ea48fd4450af95a30992f7421dafac3351': Object.freeze(SKILL_VERSIONS.slice(0, 5)),
    '4bd6901d72935cb2d04f34e6e3bfce64bbbec4043eba4dfdd43b8ab03cf52f24': Object.freeze(SKILL_VERSIONS.slice(5)),
  }),
  run: Object.freeze({
    '5ba87afa7e77fb09e69aa0e27838c933b51557f0c5241a7ca7e5bf2cd6faa5c1': Object.freeze(SKILL_VERSIONS),
  }),
});

const LEGACY_SKILL_TEXT = Object.freeze({
  decompose: 'SPEC.md and PRACTICE.md if they exist.',
  plan: 'PRACTICE.md and `pullboard lanes`.',
  review: 'SPEC.md, PRACTICE.md and the README.',
  verify: 'approved rows of PRACTICE.md that the change touches.',
});
const CURRENT_SKILL_TEXT = Object.freeze({
  decompose: 'SPEC.md and DOCTRINE.md (or PRACTICE.md when it is the only legacy file) if they exist.',
  plan: 'DOCTRINE.md (or PRACTICE.md when it is the only legacy file) and `pullboard lanes`.',
  review: 'SPEC.md, DOCTRINE.md (or PRACTICE.md when it is the only legacy file) and the README.',
  verify: 'approved rows of DOCTRINE.md (or PRACTICE.md when it is the only legacy file) that the change touches.',
});

const SKILLS_DIR = fileURLToPath(new URL('../../../../skills/', import.meta.url));
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version;

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
  triage: 'pullboard-triage',
  worker: 'pullboard-worker',
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
  // The worker loop has no file to drift: it is generated from the one shared seat-loop source (#8550).
  if (role === 'worker') return renderWorkerSkill();
  return readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
}

/** Hash skill bytes so an update can distinguish a released file from a local edit. */
function skillDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Find the newest release that shipped these exact bytes for a role. */
function shippedVersion(role, digest) {
  return SHIPPED_SKILL_DIGESTS[role]?.[digest]?.at(-1) ?? null;
}

/** Describe known guidance that differs between an old shipped line and this package. */
function missingSkillChanges(role, text) {
  const oldLine = LEGACY_SKILL_TEXT[role];
  const currentLine = CURRENT_SKILL_TEXT[role];
  if (oldLine && text.includes(oldLine)) return [`replace “${oldLine}” with “${currentLine}”`];
  if (currentLine && text.includes('PRACTICE.md') && !text.includes('DOCTRINE.md')) {
    return [`add current DOCTRINE.md guidance: “${currentLine}”`];
  }
  return [];
}

/** Find outdated shipped or edited-old skill files without treating unknown edits as history. */
export function skillProblems(root) {
  const problems = [];
  for (const [role, name] of Object.entries(ROLES)) {
    const relativePath = `.claude/skills/${name}/SKILL.md`;
    const file = join(root, relativePath);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const digest = skillDigest(text);
    const currentDigest = skillDigest(shippedSkill(role));
    if (digest === currentDigest) continue;
    const version = shippedVersion(role, digest);
    const changes = missingSkillChanges(role, text);
    if (version && version !== PACKAGE_VERSION) {
      problems.push({
        code: 'SKILL_OUTDATED',
        message: `${relativePath} matches Claude skill shipped in Pullboard ${version}; missing changes: ${changes.join('; ') || 'the current shipped skill content'}`,
        next: 'run pullboard skills --update',
      });
    } else if (changes.length) {
      problems.push({
        code: 'SKILL_EDITED_OUTDATED',
        message: `${relativePath} is closest to the Pullboard ${SKILL_VERSIONS[4]} skill, edited by you; missing changes: ${changes.join('; ')}`,
        next: 'review the current skill and merge its missing changes by hand; pullboard skills --update will preserve this edit',
      });
    }
  }
  return problems;
}

/** Update only exact previously shipped files; unknown local edits are preserved. */
export function updateSkills(root) {
  const updated = [];
  const current = [];
  const customized = [];
  for (const [role, name] of Object.entries(ROLES)) {
    const relativePath = `.claude/skills/${name}/SKILL.md`;
    const file = join(root, relativePath);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const digest = skillDigest(text);
    const currentText = shippedSkill(role);
    if (digest === skillDigest(currentText)) {
      current.push(relativePath);
      continue;
    }
    if (shippedVersion(role, digest)) {
      writeFileSync(file, currentText);
      updated.push(relativePath);
      continue;
    }
    customized.push({ path: relativePath, missing: missingSkillChanges(role, text) });
  }
  return { updated, current, customized };
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

/** Where each agent tool reads a project's skills; the same shipped bytes go to every tool the project declares. */
const SKILL_HOMES = Object.freeze({
  claude: { dir: ['.claude', 'skills'], label: 'Claude Code' },
  codex: { dir: ['.agents', 'skills'], label: 'Codex' },
});

/**
 * The agent tools a project declares by the folders and files it already has before init writes anything:
 * `.claude`, `CLAUDE.md` or `.mcp.json` mean Claude Code; `.codex` or `.agents` mean Codex. A project that
 * declares neither, or both, is set up for both.
 *
 * @param {string} root
 * @returns {Array<'claude'|'codex'>}
 */
export function declaredAgentTools(root) {
  const claude = ['.claude', 'CLAUDE.md', '.mcp.json'].some(name => existsSync(join(root, name)));
  const codex = ['.codex', '.agents'].some(name => existsSync(join(root, name)));
  if (claude && !codex) return ['claude'];
  if (codex && !claude) return ['codex'];
  return ['claude', 'codex'];
}

/**
 * Install the role guides as skills where each declared agent tool reads them (Claude Code under
 * `.claude/skills/`, Codex under `.agents/skills/`), never replacing a file that is already there (I2).
 *
 * @param {string} root
 * @param {(path: string) => void} [onWrite] Observe only newly written skill files.
 * @param {Array<'claude'|'codex'>} [tools] The agent tools to write for; Claude Code alone by default.
 * @returns {string[]} What happened.
 */
export function installSkills(root, onWrite = () => {}, tools = ['claude']) {
  const notes = [];
  for (const tool of tools) {
    const { dir, label } = SKILL_HOMES[tool];
    const written = [];
    for (const [role, name] of Object.entries(ROLES)) {
      const file = join(root, ...dir, name, 'SKILL.md');
      if (existsSync(file)) continue;
      mkdirSync(join(root, ...dir, name), { recursive: true });
      writeFileSync(file, shippedSkill(role));
      onWrite(`${dir.join('/')}/${name}/SKILL.md`);
      written.push(name);
    }
    notes.push(written.length ? `wrote ${label} skills: ${written.join(', ')}` : `kept the ${label} skills`);
  }
  return notes;
}
