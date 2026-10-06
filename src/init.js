/**
 * `pullboard init` (I1, I2): one command puts the method into a repo. It writes the config, a
 * starter spec and the agent instructions, installs the git hooks, opens the board and registers
 * the main checkout as the coordinator. It runs again safely and never overwrites a file it did not
 * write.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CONFIG_FILE, COORDINATOR } from './config.js';
import { installHooks } from './hooks.js';
import { Refused } from './refused.js';
import { installSkills } from './skills.js';
import { AGENTS_START, agentsBlock, configTemplate, practiceTemplate, specTemplate } from './templates.js';

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/**
 * The gate to start with: `npm test` when the repo has a real test script, otherwise none yet.
 *
 * @param {string} root
 * @returns {string}
 */
export function detectGate(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return '';
  try {
    const test = JSON.parse(readFileSync(file, 'utf8'))?.scripts?.test;
    return typeof test === 'string' && test.trim() && test !== NPM_DEFAULT_TEST ? 'npm test' : '';
  } catch {
    return '';
  }
}

/**
 * The fixers to start with (C5): prettier, when the repo already depends on it, on every file it
 * understands. Only fast, deterministic fixers belong at commit time; slow ones stay in the gate.
 *
 * @param {string} root
 * @returns {{ run: string, files: string[] }[]}
 */
export function detectFixers(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const hasPrettier = Boolean(pkg?.devDependencies?.prettier ?? pkg?.dependencies?.prettier);
    return hasPrettier ? [{ run: 'npx --no-install prettier --write --ignore-unknown', files: ['*'] }] : [];
  } catch {
    return [];
  }
}

/**
 * The gate the repo's config sets now, whoever wrote it, or empty when unreadable.
 *
 * @param {string} root
 * @returns {string}
 */
function configuredGate(root) {
  try {
    return String(JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')).gate ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Write a file only when it does not exist yet.
 *
 * @param {string} file
 * @param {string} text
 * @param {string} name
 * @returns {string} What happened.
 */
function writeNew(file, text, name) {
  if (existsSync(file)) return `kept ${name}`;
  writeFileSync(file, text);
  return `wrote ${name}`;
}

/**
 * Put the agent instructions in AGENTS.md, appending pullboard's block to a file the repo already
 * has, and point CLAUDE.md at AGENTS.md so Claude Code reads the same rules.
 *
 * @param {string} root
 * @returns {string[]}
 */
function writeAgentDocs(root) {
  const notes = [];
  const agents = join(root, 'AGENTS.md');
  if (!existsSync(agents)) {
    writeFileSync(agents, `# AGENTS.md\n\n${agentsBlock()}`);
    notes.push('wrote AGENTS.md');
  } else if (!readFileSync(agents, 'utf8').includes(AGENTS_START)) {
    appendFileSync(agents, `\n${agentsBlock()}`);
    notes.push('added the pullboard section to AGENTS.md');
  } else notes.push('kept AGENTS.md');
  const claude = join(root, 'CLAUDE.md');
  if (!existsSync(claude)) {
    writeFileSync(claude, '@AGENTS.md\n');
    notes.push('wrote CLAUDE.md (points at AGENTS.md)');
  } else if (!readFileSync(claude, 'utf8').includes('AGENTS.md')) {
    appendFileSync(claude, '\n@AGENTS.md\n');
    notes.push('pointed CLAUDE.md at AGENTS.md');
  }
  return notes;
}

/**
 * Set the repo up. Must run in the main checkout, which becomes the coordinator.
 *
 * @param {{ info: { root: string, isMain: boolean }, openBoardHere: () => any, register: Function, closeBoard: Function }} context
 * @returns {string[]} What happened, one line each.
 */
export function initRepo({ info, openBoardHere, register, closeBoard }) {
  if (!info.isMain) {
    throw new Refused('NOT_MAIN', 'run init in the main checkout; worktrees join a lane instead');
  }
  const { root } = info;
  const gate = detectGate(root);
  const notes = [
    writeNew(join(root, CONFIG_FILE), configTemplate(gate, detectFixers(root)), CONFIG_FILE),
    writeNew(join(root, 'SPEC.md'), specTemplate(basename(root)), 'SPEC.md'),
    writeNew(join(root, 'PRACTICE.md'), practiceTemplate(), 'PRACTICE.md'),
    ...writeAgentDocs(root),
    ...installHooks(root),
    ...installSkills(root),
  ];
  const board = openBoardHere();
  try {
    register(board, { lane: COORDINATOR, path: root });
  } finally {
    closeBoard(board);
  }
  notes.push('opened the board in the git dir; this checkout is the coordinator');
  if (!configuredGate(root)) {
    notes.push('no gate yet: set "gate" in pullboard.json to the command that proves the build');
  }
  return notes;
}
