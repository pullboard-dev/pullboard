/**
 * `pullboard init` (I1, I2): one command puts the method into a repo. It writes the config, a
 * starter spec and the agent instructions, installs the git hooks, opens the board and registers
 * the main checkout as the coordinator. It runs again safely and never overwrites a file it did not
 * write.
 */
import {
  delimiter,
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { userInfo } from 'node:os';
import {
  CONFIG_FILE,
  COORDINATOR,
  doctrineFile,
  loadConfig,
} from '../../../../packages/config/index.js';
import { loadDoctrine } from '../../../../packages/doctrine/index.js';
import { installHooks } from '../../../../packages/commits/index.js';
import { environmentAdapter } from '../../../../packages/env/index.js';
import {
  configureAgentHooks,
  LEGACY_RESUME_HOOK,
} from '../../../../packages/seats/index.js';
import {
  detectGate,
  detectLanguages,
  detectTestGlobs,
  settingCommand,
} from '../../../../packages/gate/heavy.js';
export { detectGate } from '../../../../packages/gate/heavy.js';
import {
  gitPath,
  tryGit,
} from '../../../../packages/git/index.js';
import { machineHome } from '../../../../packages/resources/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { reviewerStartup } from './next/steps.js';
import { withAffectedDefault } from '../logic/init/affected-default.js';
import { languageNotes } from '../logic/init/language-notes.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { remoteShell } from '../../../../packages/person/index.js';
import { declaredAgentTools } from './skills.js';
import { installCodexAutomation } from './skills.js';
import { installSkills } from './skills.js';
import {
  AGENTS_END,
  AGENTS_START,
  COORDINATOR_GUIDE_FILE,
  renderCoordinatorGuide,
  claudeLoopRules,
  codexLoopRules,
  configTemplate,
  defaults,
  plainGateWords,
  practiceTemplate,
  renderAgentsBlock,
  specTemplate,
} from '../../../../packages/config/index.js';
import { doctrineText } from '../../../../packages/doctrine/index.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Resolve a directory through symlinks, retaining a missing suffix for a not-yet-created private home. */
function canonicalDirectoryPath(candidate) {
  let cursor = resolve(candidate);
  const missing = [];
  while (true) {
    try {
      const physical = fs.realpath(cursor);
      if (!fs.stat(physical).isDirectory()) return null;
      return resolve(physical, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      try { fs.lstat(cursor); return null; } catch (statError) {
        if (statError.code !== 'ENOENT') return null;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

/** Keep an automatic machine-home write grant below the OS user home and away from filesystem roots. */
export function machineHomeWriteScopeIsNarrow(machinePath, userHome = userInfo().homedir) {
  const target = canonicalDirectoryPath(machinePath);
  const home = canonicalDirectoryPath(userHome);
  if (!target || !home || target === parse(target).root) return false;
  const homeFromTarget = relative(target, home);
  const targetContainsHome = homeFromTarget === '' || (homeFromTarget !== '..'
    && !homeFromTarget.startsWith(`..${sep}`) && !isAbsolute(homeFromTarget));
  return !targetContainsHome;
}

/** Folders a lane proposal never hands out: dependencies and build output. */
const NOT_LANE_FOLDERS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage']);

/**
 * The visible folders directly inside `dir`, sorted, without dependencies or build output.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function visibleFolders(dir) {
  if (!fs.exists(dir)) return [];
  return fs.list(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NOT_LANE_FOLDERS.has(entry.name))
    .map((entry) => entry.name).sort();
}

/**
 * A lane name made from a folder name: lowercase letters, digits and dashes, starting with a letter.
 *
 * @param {string} folder
 * @returns {string}
 */
function laneNameFor(folder) {
  const name = folder.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^[^a-z]+/u, '').replace(/-+$/u, '').slice(0, 31).replace(/-+$/u, '');
  return name || 'lane';
}

/**
 * The lanes init proposes from the repo's layout (I1, I2): one lane per top-level package for a
 * packages/* or apps/* layout, and one app lane owning the top-level folders otherwise. Nothing is
 * proposed once any lane owns a folder. Init never writes them: the agent in the main checkout adds them
 * with the printed `pullboard lane add` command and tells the person (#914).
 *
 * @param {string} root
 * @param {any} [config] - The repo's config; read from root when omitted.
 * @returns {{ name: string, owns: string[] }[]}
 */
export function proposeLanes(root, config = loadConfig(root)) {
  if (Object.values(config.lanes).some((lane) => lane.owns.length)) return [];
  const taken = new Set([COORDINATOR, 'all', ...Object.keys(config.lanes)]);
  const proposals = [];
  for (const parent of ['packages', 'apps']) {
    for (const folder of visibleFolders(join(root, parent))) {
      let name = laneNameFor(folder);
      if (taken.has(name)) name = laneNameFor(`${parent}-${folder}`);
      for (let n = 2; taken.has(name); n += 1) name = `${laneNameFor(`${parent}-${folder}`).slice(0, 28)}-${n}`;
      taken.add(name);
      proposals.push({ name, owns: [`${parent}/${folder}/`] });
    }
  }
  if (proposals.length) return proposals;
  const folders = visibleFolders(root);
  return [{ name: taken.has('app') ? 'app-1' : 'app', owns: folders.length ? folders.map((folder) => `${folder}/`) : ['app/'] }];
}

/**
 * The lane a blueprint starter is filed in (I1, S1). A starter is built in a build lane, never the
 * coordinator lane: the coordinator verifies and merges, and nothing moves an item between lanes,
 * so a starter filed there had to be withdrawn and filed again (blueprint trial, finding 3). In
 * order: the starter's own lane when it exists or is proposed, else the first declared lane that
 * owns folders, else the first lane init proposes. A proposed lane is used by name and never
 * written: the agent adds it with its `pullboard lane add` command, and the starters are
 * waiting in it from then on.
 *
 * @param {string | undefined} wanted - The lane the blueprint names for this starter, if any.
 * @param {any} config - The repo's config.
 * @param {{ name: string, owns: string[] }[]} proposals - The lanes init proposes, from proposeLanes.
 * @returns {{ lane: string, proposal: { name: string, owns: string[] } | null }}
 */
export function starterLane(wanted, config, proposals) {
  const proposalFor = (name) => proposals.find((lane) => lane.name === name) ?? null;
  // A lane that owns no folders, like a verifier lane, builds nothing, so it never takes a starter.
  const builds = (name) => name !== COORDINATOR && Object.hasOwn(config.lanes, name) && config.lanes[name].owns.length > 0;
  if (wanted && (builds(wanted) || (!Object.hasOwn(config.lanes, wanted) && proposalFor(wanted)))) {
    return { lane: wanted, proposal: builds(wanted) ? null : proposalFor(wanted) };
  }
  const asked = wanted ? { asked: wanted } : {};
  const built = Object.keys(config.lanes).find(builds);
  if (built) return { lane: built, proposal: null, ...asked };
  // proposeLanes always proposes one lane when no lane owns a folder, so this is never empty.
  return { lane: proposals[0].name, proposal: proposals[0], ...asked };
}

/**
 * The lines blueprint add prints for starters that named a lane they could not go to: which lane
 * they asked for, why it was not used, and where they went instead, so a person reading the output
 * knows the blueprint's lane was set aside.
 *
 * @param {{ lane: string, askedLane?: string }[]} placed - The starters filed, each with its lane.
 * @param {any} config - The repo's config.
 * @returns {string[]}
 */
export function askedLaneNotes(placed, config) {
  const groups = new Map();
  for (const { lane, askedLane: asked } of placed) {
    if (!asked) continue;
    const key = `${asked}\n${lane}`;
    groups.set(key, { asked, lane, count: (groups.get(key)?.count ?? 0) + 1 });
  }
  return [...groups.values()].map(({ asked, lane, count }) => {
    const why = asked === COORDINATOR ? 'which verifies and merges' : Object.hasOwn(config.lanes, asked) ? 'which owns no folders' : 'which does not exist';
    return `${count} starter ${count === 1 ? 'item' : 'items'} asked for the ${asked} lane, ${why}, so ${count === 1 ? 'it is' : 'they are'} filed in the ${lane} lane`;
  });
}

/**
 * The lines blueprint add prints when its starters went into a proposed lane: where they are,
 * and the one command that adds the lane.
 *
 * @param {{ name: string, owns: string[] }[]} proposed - The proposed lanes starters were filed in.
 * @returns {string[]}
 */
export function starterLaneNotes(proposed) {
  if (!proposed.length) return [];
  const [, accept] = laneProposalNotes(proposed);
  return [`starter items filed in the ${proposed.map((lane) => lane.name).join(' and ')} lane, proposed; add it to start them`, accept];
}

/**
 * Quote one word for a POSIX shell when it needs quoting.
 *
 * @param {string} word
 * @returns {string}
 */
const shellWord = (word) => (/^[A-Za-z0-9_./,@%+=:-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * The init lines that show proposed lanes and the one command that adds them; the agent runs it and tells the person.
 *
 * @param {{ name: string, owns: string[] }[]} proposals
 * @returns {string[]}
 */
export function laneProposalNotes(proposals) {
  if (!proposals.length) return [];
  return [
    `proposed lanes: ${proposals.map((lane) => `${lane.name} owns ${lane.owns.join(' ')}`).join('; ')}`,
    // An agent adds the first lanes itself and says so; stopping to ask stalled every model in the #849 trial (#914).
    `add them from the main checkout, then tell the person which lanes you made: ${proposals.map((lane) => `pullboard lane add ${shellWord(lane.name)} --owns ${shellWord(lane.owns.join(','))}`).join(' && ')}`,
  ];
}

/** Check whether a command can be found on PATH or in a named project environment without running it. */
function gateCommandAvailable(root, command) {
  const env = environmentAdapter();
  /** Check one file without executing it or resolving arbitrary shell syntax. */
  const executableFile = (file) => {
    try {
      const info = fs.stat(file);
      if (!info.isFile()) return false;
      if (process.platform === 'win32') return true;
      fs.access(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  /** Return platform command-name variants for a directory lookup. */
  const commandFiles = (directory) => {
    const base = join(directory, command);
    if (process.platform !== 'win32' || /\.[^\\/]+$/u.test(command)) return [base];
    return (env.get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => `${base}${extension}`);
  };
  /** Check a PATH directory entry, using the process working directory for an empty entry. */
  const onPath = (directory) => {
    return commandFiles(directory || process.cwd()).some(executableFile);
  };
  if ((env.get('PATH') ?? '').split(delimiter).some(onPath)) return true;

  /** Check conventional executable directories inside a named environment. */
  const hasEnvironmentCommand = (environment) => [
    ...commandFiles(join(environment, 'bin')),
    ...commandFiles(join(environment, 'Scripts')),
  ].some(executableFile);

  const environments = new Set([join(root, '.venv')]);
  if (env.get('UV_PROJECT_ENVIRONMENT')) {
    const configured = env.get('UV_PROJECT_ENVIRONMENT');
    environments.add(resolve(root, configured));
  }
  if (env.get('POETRY_ACTIVE') && env.get('VIRTUAL_ENV')) environments.add(env.get('VIRTUAL_ENV'));
  if ([...environments].some(hasEnvironmentCommand)) return true;
  return false;
}

/** Describe a detected gate that init cannot resolve without executing it. */
function missingGateNote(root, gate) {
  const env = environmentAdapter();
  if (!gate) return '';
  const command = gate.trim().split(/\s+/u)[0];
  if (gateCommandAvailable(root, command)) return '';
  if (command === 'pytest') {
    const hasPoetry = fs.exists(join(root, 'poetry.lock'));
    const hasUv = fs.exists(join(root, 'uv.lock')) || Boolean(env.get('UV_PROJECT_ENVIRONMENT'));
    const searched = ['PATH', 'project `.venv`'];
    if (env.get('UV_PROJECT_ENVIRONMENT')) searched.push('configured uv environment');
    if (env.get('POETRY_ACTIVE') && env.get('VIRTUAL_ENV')) searched.push('active Poetry environment');
    const setupHint = hasUv ? 'run `uv sync` and activate its `.venv`'
      : hasPoetry ? 'run `poetry install` and activate that environment'
        : 'install pytest or activate the project `.venv`';
    return `gate command "pytest" is not available on ${searched.join(', ')}; ${setupHint} before running it`;
  }
  return `gate command "${command}" is not available on PATH; install it before running the gate`;
}

/**
 * The repo root's parsed package.json, or null when it is absent or unreadable.
 *
 * @param {string} root
 * @returns {object | null}
 */
function readPackageJson(root) {
  try {
    return JSON.parse(fs.readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
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
  if (!fs.exists(file)) return [];
  try {
    const pkg = JSON.parse(fs.readFile(file, 'utf8'));
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
    return String(JSON.parse(fs.readFile(join(root, CONFIG_FILE), 'utf8')).gate ?? '').trim();
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
 * @param {(path: string) => void} onWrite
 * @returns {string} What happened.
 */
function writeNew(file, text, name, onWrite) {
  if (fs.exists(file)) return `kept ${name}`;
  fs.writeFile(file, text);
  onWrite(name);
  return `wrote ${name}`;
}

/** Ignore Claude's nested agent worktrees, preserving existing ignore bytes and second-run idempotence. */
function ignoreAgentWorktrees(root, onWrite) {
  const file = join(root, '.gitignore');
  const pattern = '.claude/worktrees/';
  const existing = fs.exists(file);
  const previous = existing ? fs.readFile(file, 'utf8') : '';
  if (previous.split(/\r?\n/u).includes(pattern)) return 'kept .gitignore (already ignores .claude/worktrees/)';
  fs.appendFile(file, (previous && !previous.endsWith('\n') ? '\n' : '') + pattern + '\n');
  onWrite('.gitignore');
  return existing ? 'added .claude/worktrees/ to .gitignore' : 'wrote .gitignore (ignores .claude/worktrees/)';
}

/**
 * Put the agent instructions in AGENTS.md, appending pullboard's block to a file the repo already
 * has, and point CLAUDE.md at AGENTS.md so Claude Code reads the same rules.
 *
 * @param {string} root
 * @param {(path: string) => void} onWrite
 * @returns {string[]}
 */
function writeAgentDocs(root, onWrite) {
  const notes = [];
  const agents = join(root, 'AGENTS.md');
  const doctrine = loadDoctrine(root, loadConfig(root));
  const block = renderAgentsBlock(doctrine, doctrineText(doctrine));
  if (!fs.exists(agents)) {
    fs.writeFile(agents, `# AGENTS.md\n\n${block}`);
    onWrite('AGENTS.md');
    notes.push('wrote AGENTS.md');
  } else if (!fs.readFile(agents, 'utf8').includes(AGENTS_START)) {
    fs.appendFile(agents, `\n${block}`);
    onWrite('AGENTS.md');
    notes.push('added the pullboard section to AGENTS.md');
  } else {
    const previous = fs.readFile(agents, 'utf8');
    const start = previous.indexOf(AGENTS_START);
    const end = previous.indexOf(AGENTS_END, start);
    if (end < 0) notes.push('kept AGENTS.md (incomplete pullboard markers; restore the closing marker to refresh)');
    else {
      const updated = previous.slice(0, start) + block.trimEnd() + previous.slice(end + AGENTS_END.length);
      if (updated === previous) notes.push('kept AGENTS.md');
      else {
        fs.writeFile(agents, updated);
        onWrite('AGENTS.md');
        notes.push('updated the pullboard section in AGENTS.md');
      }
    }
  }
  const guide = writeNew(join(root, COORDINATOR_GUIDE_FILE), renderCoordinatorGuide(), COORDINATOR_GUIDE_FILE, onWrite);
  if (guide.startsWith('wrote')) notes.push(`${guide} (the coordinator's guide)`);
  const claude = join(root, 'CLAUDE.md');
  if (!fs.exists(claude)) {
    fs.writeFile(claude, '@AGENTS.md\n');
    onWrite('CLAUDE.md');
    notes.push('wrote CLAUDE.md (points at AGENTS.md)');
  } else if (!fs.readFile(claude, 'utf8').includes('AGENTS.md')) {
    fs.appendFile(claude, '\n@AGENTS.md\n');
    onWrite('CLAUDE.md');
    notes.push('pointed CLAUDE.md at AGENTS.md');
  }
  return notes;
}

/**
 * The session hook's command: pullboard from this checkout's install, else the main checkout's,
 * else the PATH, and silence when there is none, so a session never fails to start over it.
 */
export const RESUME_HOOK = LEGACY_RESUME_HOOK;

/**
 * The MCP server command: pullboard from this checkout's install, else the main checkout's, else the PATH (#961).
 * It runs through sh -c, as the session hook does, so one entry works however pullboard was installed.
 */
export const MCP_COMMAND =
  'm=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/..; for p in node_modules/.bin/pullboard "$m/node_modules/.bin/pullboard"; do [ -x "$p" ] && exec "$p" mcp; done; command -v pullboard >/dev/null && exec pullboard mcp; echo "pullboard is not installed; npm i -D pullboard" >&2; exit 1';

/**
 * Decode the body of a TOML basic string: \\b \\t \\n \\f \\r \\e \\" \\\\, \\uXXXX and \\UXXXXXXXX. Null for an escape
 * TOML does not define, so a key that cannot be read names nothing rather than crashing init (#961).
 *
 * @param {string} body
 * @returns {string | null}
 */
function tomlBasicString(body) {
  const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' };
  let out = '';
  for (let at = 0; at < body.length; at += 1) {
    if (body[at] !== '\\') { out += body[at]; continue; }
    const kind = body[at + 1];
    if (kind in simple) { out += simple[kind]; at += 1; continue; }
    const width = kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
    const hex = body.slice(at + 2, at + 2 + width);
    if (!width || !/^[0-9A-Fa-f]+$/u.test(hex) || hex.length !== width) return null;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    at += 1 + width;
  }
  return out;
}

/**
 * A Codex config.toml's lines, each with whether it begins inside a multi-line string ("""…""" or \'\'\'…\'\'\'). Such a
 * line is text, never a table header or a key, however it looks (#961).
 *
 * @param {string} contents
 * @returns {{ text: string, inString: boolean }[]}
 */
function tomlLines(contents) {
  const lines = String(contents).split(/\r?\n/u);
  const result = [];
  let multi = '';
  for (const text of lines) {
    result.push({ text, inString: Boolean(multi) });
    let quote = '';
    for (let at = 0; at < text.length; at += 1) {
      if (multi) {
        if (multi === '"""' && text[at] === '\\') { at += 1; continue; }
        if (text.startsWith(multi, at)) { at += multi.length - 1; multi = ''; }
        continue;
      }
      const char = text[at];
      if (quote === '"' && char === '\\') { at += 1; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (text.startsWith('"""', at) || text.startsWith("\'\'\'", at)) { multi = text.slice(at, at + 3); at += 2; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === '#') break;
    }
  }
  return result;
}

/**
 * Split a TOML key such as `mcp_servers.'pullboard'` into its parts: bare, "basic" or 'literal', dots between.
 *
 * @param {string} text
 * @returns {string[]|null} null when the text is not a plain dotted key.
 */
function tomlKeyParts(text) {
  const parts = [];
  const pattern = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)/uy;
  let match;
  while (pattern.lastIndex < text.length && (match = pattern.exec(text))) {
    const part = match[1] ?? (match[2] !== undefined ? tomlBasicString(match[2]) : match[3]);
    if (part === null) return null;
    parts.push(part);
    if (!match[4]) return pattern.lastIndex === text.length ? parts : null;
  }
  return null;
}

/**
 * Drop a TOML line's comment: a # outside any quoted string.
 *
 * @param {string} line
 * @returns {string}
 */
function withoutTomlComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"' && char === '\\') index += 1;
    else if (quote && char === quote) quote = '';
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === '#') return line.slice(0, index);
  }
  return line;
}

/**
 * Whether a Codex config.toml already defines an MCP server by this name, in any form TOML allows: a
 * `[mcp_servers.name]` table with quoted keys or a trailing comment, its subtables, dotted keys under
 * `[mcp_servers]` or the top level, or an inline table. Init must keep such a server and add no second
 * one, since a duplicate makes the whole file invalid TOML (#961).
 *
 * @param {string} contents
 * @param {string} name
 * @returns {boolean}
 */
export function codexHasMcpServer(contents, name) {
  const names = (path) => path.length >= 2 && path[0] === 'mcp_servers' && path[1] === name;
  let table = [];
  for (const { text: raw, inString } of tomlLines(contents)) {
    if (inString) continue;
    const line = withoutTomlComment(raw).trim();
    const header = /^\[\[?(.+?)\]\]?$/u.exec(line);
    if (header) {
      table = tomlKeyParts(header[1]) ?? [];
      if (names(table)) return true;
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = tomlKeyParts(line.slice(0, equals));
    if (!key) continue;
    const path = [...table, ...key];
    if (names(path)) return true;
    // An inline table: mcp_servers = { name = { ... } } names the server among its keys.
    const value = line.slice(equals + 1);
    if (path.length === 1 && path[0] === 'mcp_servers' && new RegExp(`[{,]\\s*(?:${name}|"${name}"|'${name}')\\s*[.=]`, 'u').test(value)) return true;
  }
  return false;
}

/**
 * The end of one simple TOML value starting at `at`: a basic or literal string, a number, a boolean, or a single-line
 * array of those. -1 for anything else, such as an inline table, a date or a multi-line string (#961).
 *
 * @param {string} text
 * @param {number} at
 * @returns {number}
 */
function simpleTomlValueEnd(text, at) {
  if (text.startsWith('"""', at) || text.startsWith("\'\'\'", at)) return -1;
  if (text[at] === '"') {
    const match = /"((?:[^"\\]|\\.)*)"/uy;
    match.lastIndex = at;
    const found = match.exec(text);
    return found && tomlBasicString(found[1]) !== null ? match.lastIndex : -1;
  }
  if (text[at] === "\'") {
    const close = text.indexOf("\'", at + 1);
    return close === -1 ? -1 : close + 1;
  }
  if (text[at] === '[') {
    let index = at + 1;
    for (;;) {
      while (text[index] === ' ' || text[index] === '\t') index += 1;
      if (text[index] === ']') return index + 1;
      const end = text[index] === '[' ? -1 : simpleTomlValueEnd(text, index);
      if (end === -1) return -1;
      index = end;
      while (text[index] === ' ' || text[index] === '\t') index += 1;
      if (text[index] === ',') index += 1;
      else if (text[index] !== ']') return -1;
    }
  }
  const scalar = /(?:true|false|[+-]?(?:inf|nan)|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)(?=[\s,\]#]|$)/uy;
  scalar.lastIndex = at;
  return scalar.exec(text) ? scalar.lastIndex : -1;
}

/**
 * Whether init may edit this Codex config.toml: every line is blank, a comment, a [table] or [a.b] header, or a
 * single-line key = value whose value is a string, number, boolean or single-line array, and nothing assigns
 * mcp_servers a value of its own. Outside that subset init writes nothing and prints the block for the person: a
 * reviewer grades this subset and the fallback, not every TOML form (#961).
 *
 * @param {string} contents
 * @returns {boolean}
 */
export function codexConfigEditable(contents) {
  let table = [];
  for (const raw of String(contents).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^[\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (header) {
      table = tomlKeyParts(header[1]);
      if (!table) return false;
      continue;
    }
    const equals = line.indexOf('=');
    const key = equals > 0 ? tomlKeyParts(line.slice(0, equals)) : null;
    if (!key) return false;
    const path = [...table, ...key];
    if (path.length === 1 && path[0] === 'mcp_servers') return false;
    let at = equals + 1;
    while (line[at] === ' ' || line[at] === '\t') at += 1;
    const end = simpleTomlValueEnd(line, at);
    if (end === -1 || !/^\s*(?:#.*)?$/u.test(line.slice(end))) return false;
  }
  return true;
}

/** The one [mcp_servers.pullboard] block init writes, or prints for the person when it cannot write it (#961). */
export const CODEX_MCP_BLOCK = `[mcp_servers.pullboard]\ncommand = "sh"\nargs = ["-c", ${JSON.stringify(MCP_COMMAND)}]`;

/** How a note begins when Codex needs the person: an inline mcp_servers table that init leaves byte-identical. */
export const CODEX_MANUAL_NOTE = 'kept .codex/config.toml as written: it uses TOML beyond the simple lines init edits (such as an inline table or a multi-line string).';

/**
 * How init left each client's MCP server, read from its notes: added, kept (already there), or manual (the person adds
 * it). --json reports this so a script can tell a Codex setup that needs the person (#961).
 *
 * @param {string[]} notes
 * @returns {{ claude: 'added'|'kept'|'manual', codex: 'added'|'kept'|'manual' }}
 */
export function mcpSetup(notes) {
  const has = (start) => notes.some((note) => note.startsWith(start));
  return {
    claude: has('added pullboard mcp to .mcp.json') ? 'added' : has('kept the Claude Code MCP server') ? 'kept' : 'manual',
    codex: has(CODEX_MANUAL_NOTE) ? 'manual' : has('added pullboard mcp to .codex/config.toml') ? 'added' : 'kept',
  };
}

/**
 * Register pullboard mcp for Claude Code (.mcp.json) and Codex (.codex/config.toml), merging with any servers already
 * there and never replacing a pullboard entry or a file it cannot read, so an agent can work the loop through MCP (#961).
 *
 * @param {string} root
 * @param {(path: string) => void} onWrite
 * @returns {string[]} What happened, one note per client.
 */
function writeMcpConfig(root, onWrite) {
  const notes = [];
  const claude = join(root, '.mcp.json');
  let config = {};
  if (fs.exists(claude)) {
    try { config = JSON.parse(fs.readFile(claude, 'utf8')); } catch { config = null; }
  }
  const servers = config?.mcpServers;
  if (!config || typeof config !== 'object' || Array.isArray(config) || (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers)))) {
    notes.push('kept .mcp.json, which is not a JSON object with an mcpServers object; add a pullboard server that runs pullboard mcp');
  } else if (servers && Object.hasOwn(servers, 'pullboard')) {
    notes.push('kept the Claude Code MCP server in .mcp.json');
  } else {
    config.mcpServers = { ...servers, pullboard: { command: 'sh', args: ['-c', MCP_COMMAND] } };
    fs.writeFile(claude, `${JSON.stringify(config, null, 2)}\n`);
    onWrite('.mcp.json');
    notes.push('added pullboard mcp to .mcp.json for Claude Code');
  }
  const codex = join(root, '.codex', 'config.toml');
  const contents = fs.exists(codex) ? fs.readFile(codex, 'utf8') : '';
  if (!codexConfigEditable(contents)) {
    // Outside the simple subset init never rewrites what the person wrote: it prints the block for them to add (#961).
    notes.push(`${CODEX_MANUAL_NOTE} To run pullboard mcp in Codex, add this server yourself, as this table or as a pullboard entry in your mcp_servers table:\n${CODEX_MCP_BLOCK}`);
  } else if (codexHasMcpServer(contents, 'pullboard')) {
    notes.push('kept the Codex MCP server in .codex/config.toml');
  } else {
    // A new table at the end is valid TOML after any simple content, so nothing already there is rewritten.
    const prefix = contents && !contents.endsWith('\n') ? `${contents}\n` : contents;
    const table = `${prefix ? `${prefix}\n` : ''}${CODEX_MCP_BLOCK}\n`;
    fs.mkdir(join(root, '.codex'), { recursive: true });
    fs.writeFile(codex, table);
    onWrite('.codex/config.toml');
    notes.push('added pullboard mcp to .codex/config.toml for Codex; trust this project so Codex loads it');
  }
  return notes;
}

/**
 * Merge Claude project rules and the exact machine-home sandbox write scope, preserving other settings.
 *
 * @param {string} root
 * @param {string} gate
 * @param {(path: string) => void} onWrite
 * @returns {string} A concise setup note.
 */
function writeClaudeLoopPermissions(root, gate, onWrite) {
  const file = join(root, '.claude', 'settings.json');
  let settings = {};
  if (fs.exists(file)) {
    try {
      settings = JSON.parse(fs.readFile(file, 'utf8'));
    } catch {
      settings = null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return 'kept .claude/settings.json because it is not a JSON object; add the Pullboard allow rules manually';
    }
  }
  const current = settings.permissions;
  if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) {
    return 'kept .claude/settings.json because permissions is not an object; add the Pullboard allow rules manually';
  }
  const permissions = current ?? {};
  const allow = permissions.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    return 'kept .claude/settings.json because permissions.allow is not an array; add the Pullboard allow rules manually';
  }
  const existing = allow ?? [];
  const requested = claudeLoopRules({ gate });
  const missing = requested.filter(rule => !existing.includes(rule));
  const sandbox = settings.sandbox;
  if (sandbox !== undefined && (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox))) {
    return 'kept .claude/settings.json because sandbox is not an object; add the Pullboard machine-home sandbox write path manually';
  }
  const currentFilesystem = sandbox?.filesystem;
  if (currentFilesystem !== undefined && (!currentFilesystem || typeof currentFilesystem !== 'object' || Array.isArray(currentFilesystem))) {
    return 'kept .claude/settings.json because sandbox.filesystem is not an object; add the Pullboard machine-home sandbox write path manually';
  }
  const filesystem = currentFilesystem ?? {};
  const allowWrite = filesystem.allowWrite;
  if (allowWrite !== undefined && !Array.isArray(allowWrite)) {
    return 'kept .claude/settings.json because sandbox.filesystem.allowWrite is not an array; add the Pullboard machine-home sandbox write path manually';
  }
  const machinePath = machineHome();
  const machinePathIsNarrow = machineHomeWriteScopeIsNarrow(machinePath);
  const machineWrites = allowWrite ?? [];
  const missingMachineWrite = machinePathIsNarrow && !machineWrites.includes(machinePath);
  if (missing.length || missingMachineWrite) {
    settings.permissions = { ...permissions, allow: [...existing, ...missing] };
    if (missingMachineWrite) {
      settings.sandbox = {
        ...sandbox,
        filesystem: { ...filesystem, allowWrite: [...machineWrites, machinePath] },
      };
    }
    fs.mkdir(join(root, '.claude'), { recursive: true });
    fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    onWrite('.claude/settings.json');
  }
  const gateWords = plainGateWords(gate);
  const gateNote = gateWords ? `, and the detected gate (${gateWords.join(' ')})` : gate ? '; the configured shell gate was left for manual approval' : '';
  const editNote = requested.some(rule => rule.startsWith('Edit(')) ? ', plus edits within this worktree' : '';
  const permissionsNote = missing.length ? `allowed Claude Code's Pullboard loop and listed Git commands${gateNote}${editNote}` : 'kept the existing Claude Code Pullboard permissions';
  const machineWriteNote = !machinePathIsNarrow
    ? 'did not grant machine-home write because it is the OS home, an ancestor of the OS home, or a filesystem root; choose a narrower PULLBOARD_MACHINE_HOME'
    : missingMachineWrite ? 'added the exact Pullboard machine-home Bash write path' : 'kept the existing exact Pullboard machine-home Bash write path';
  return `${permissionsNote}; ${machineWriteNote}; an admin-required sandbox may ignore project-level write additions; existing deny and ask rules still apply`;
}

/**
 * Write project-local Codex command rules without touching the user's home or active-session config.
 *
 * @param {string} root
 * @param {string} gate
 * @param {(path: string) => void} onWrite
 * @returns {string} A concise setup note.
 */
function writeCodexLoopRules(root, gate, onWrite) {
  const file = join(root, '.codex', 'rules', 'pullboard.rules');
  const machinePath = machineHome();
  const rules = codexLoopRules(gate);
  let contents = '';
  if (fs.exists(file)) contents = fs.readFile(file, 'utf8');
  const lines = new Set(contents.split(/\r?\n/u));
  const missing = rules.filter(rule => !lines.has(rule));
  if (missing.length) {
    fs.mkdir(join(root, '.codex', 'rules'), { recursive: true });
    const prefix = contents && !contents.endsWith('\n') ? `${contents}\n` : contents;
    fs.writeFile(file, `${prefix}${missing.join('\n')}\n`);
    onWrite('.codex/rules/pullboard.rules');
  }
  const gateNote = plainGateWords(gate) ? '' : gate ? '; the configured shell gate was left for manual approval' : '';
  const rulesNote = missing.length ? `added trusted-project Codex rules for Pullboard and the listed Git commands${gateNote}` : 'kept the existing Codex project rules';
  if (!machineHomeWriteScopeIsNarrow(machinePath)) {
    return `${rulesNote}; trust this project and restart the session to load rules. Machine-home write was not granted because the path is the OS home, an ancestor of it, or a filesystem root; choose a narrower PULLBOARD_MACHINE_HOME`;
  }
  // The board folder sits under .git, which Codex keeps read-only, so it is granted beside the machine home (#913).
  const workspaceWrite = `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([machinePath, gitPath(root, 'pullboard')])}`;
  const profileWrite = `${JSON.stringify(machinePath)} = "write" and ${JSON.stringify(gitPath(root, 'pullboard'))} = "write"`;
  return `${rulesNote}; trust this project and restart the session to load rules. For machine-home access, merge these exact values into legacy Codex settings: put sandbox_mode at the TOML top level before any table, append these exact paths to any existing writable_roots array while keeping its entries, and do not duplicate the table or replace unrelated settings:\n${workspaceWrite}\nPermission-profile users add ${profileWrite} under their existing [permissions.<active-profile>.filesystem] table instead, since a named profile ignores writable_roots; do not mix the two configuration formats. Official docs: https://learn.chatgpt.com/docs/config-file/config-reference and https://learn.chatgpt.com/docs/permissions`;
}

/**
 * Set the repo up. Must run in the main checkout, which becomes the coordinator.
 *
 * @param {{ info: { root: string, isMain: boolean }, openBoardHere: () => any, register: Function, closeBoard: Function, model?: string, permissions?: boolean, onWritten?: (path: string) => void }} context
 * @returns {string[]} What happened, one line each.
 */
export function initRepo({ info, openBoardHere, register, closeBoard, model, permissions = true, agentHooks = true, onWritten }) {
  if (!info.isMain) {
    throw new Refused('NOT_MAIN', 'run init in the main checkout; worktrees join a lane instead');
  }
  const { root } = info;
  // Read before any write: setup's own CLAUDE.md and .claude files must not count as the project's declaration.
  const agentTools = declaredAgentTools(root);
  const worktreeMode = fs.exists(join(root, CONFIG_FILE)) ? loadConfig(root).worktrees : 'inside';
  const doctrine = fs.exists(join(root, CONFIG_FILE)) ? loadConfig(root).practice : doctrineFile(root);
  const gate = detectGate(root);
  const configured = configuredGate(root);
  const config = withAffectedDefault(JSON.parse(configTemplate(gate, detectFixers(root))), detectLanguages(root), readPackageJson(root));
  // A repo's own test files are protected as bar files for every detected language, not only Node's [#3707].
  const testGlobs = detectTestGlobs(root);
  if (testGlobs.length) config.claim = { barTestFiles: [...defaults().claim.barTestFiles, ...testGlobs] };
  if (!tryGit(root, ['remote']).stdout) config.landing = { publish: 'separate' };
  const written = [];
  /** Record only paths setup actually writes; unrelated files never enter its staging command. */
  const onWrite = (path) => { if (!written.includes(path)) written.push(path); onWritten?.(path); };
  const notes = [
    writeNew(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, CONFIG_FILE, onWrite),
    writeNew(join(root, 'SPEC.md'), specTemplate(basename(root), gate), 'SPEC.md', onWrite),
    writeNew(join(root, doctrine), practiceTemplate(), doctrine, onWrite),
    ignoreAgentWorktrees(root, onWrite),
    worktreeMode === 'inside'
      ? 'new agent worktrees go in .claude/worktrees; dot-scanner tools such as eslint . should ignore .claude/worktrees; set "worktrees": "beside" in pullboard.json to use sibling folders'
      : 'new agent worktrees go beside this repository as <repo>-<lane>-N; set "worktrees": "inside" in pullboard.json to nest them under .claude/worktrees (dot-scanner tools such as eslint . should ignore that path)',
    ...writeAgentDocs(root, onWrite),
    ...installHooks(root, onWrite),
    ...installSkills(root, onWrite, agentTools),
    ...installCodexAutomation(root, onWrite, agentTools),
    ...(agentHooks ? configureAgentHooks(root, { legacyResume: RESUME_HOOK, onWrite }) : ['skipped agent nudges (--no-hooks)']),
    ...writeMcpConfig(root, onWrite),
  ];
  if (gate && (!configured || configured === gate)) {
    const gateNote = missingGateNote(root, gate);
    if (gateNote) notes.push(gateNote);
  }
  if (permissions) {
    const gateForPermissions = configuredGate(root) || gate;
    notes.push(writeClaudeLoopPermissions(root, gateForPermissions, onWrite));
    notes.push(writeCodexLoopRules(root, gateForPermissions, onWrite));
  }
  const board = openBoardHere();
  try {
    register(board, { lane: COORDINATOR, path: root, model });
  } finally {
    closeBoard(board);
  }
  notes.push('opened the board in the git dir; this checkout is the coordinator');
  notes.push(reviewerStartup(root, loadConfig(root)));
  notes.push(...laneProposalNotes(proposeLanes(root)));
  if (!configuredGate(root)) {
    notes.push(gate
      ? `no gate yet: record the command that proves the build with ${settingCommand(root, gate)}`
      : `no test command detected; ask the person which command tests this project, then record it with pullboard gate set '<command>'; if this board has no build, use ${settingCommand(root)} to check its spec and practice files; a second agent review checks the actual work`);
  }
  notes.push(...languageNotes(detectLanguages(root)));
  if (written.length) notes.push(`git add -f -- ${written.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')}`);
  return notes;
}

/** The one command that shares every board on this computer with the phone and pullboard.dev. */
export const RELAY_ON_ALL = 'pullboard relay on --all';

/** Refresh only managed permission files after a blueprint supplies the final gate command. */
export function refreshInitPermissions(root, onWritten) {
  const gate = configuredGate(root) || detectGate(root);
  return [writeClaudeLoopPermissions(root, gate, onWritten), writeCodexLoopRules(root, gate, onWritten)];
}

/** The question init asks a person at the end of setup; Enter means yes. */
export const RELAY_OFFER_QUESTION = 'See this board on your phone and pullboard.dev? Sign in with GitHub [Y/n] ';

/** The line init prints when it does not ask, or when the person answers no. */
export const RELAY_LATER = `To see your boards on your phone and pullboard.dev later, run ${RELAY_ON_ALL}`;

/**
 * Tell whether this run is under continuous integration. CI services set CI, usually to true;
 * an explicit false or 0 is a person saying it is not.
 *
 * @param {Record<string, string | undefined>} environment
 * @returns {boolean}
 */
function continuousIntegration(environment) {
  const value = String(environment.CI ?? '').trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0';
}

/**
 * What init does about sharing with the phone at its end (H5, H17, B26): 'ask' the person,
 * 'print' the command for later, or 'none'. Sign-in is the person's alone, so the question is
 * asked only at a person's own terminal: an agent shell is never asked even when its stdin is a
 * terminal, and neither is CI, an SSH shell (relay on --all refuses there) or a run without a
 * terminal on both stdin and stdout, so nothing ever waits on an answer no one can give. Those
 * runs print the command instead. With the machine setting off, or once this board is linked or
 * this machine already shares its boards, init says nothing about it.
 *
 * @param {{ enabled: boolean, shared: boolean, environment?: Record<string, string | undefined>, stdin?: { isTTY?: boolean }, stdout?: { isTTY?: boolean } }} facts
 * @returns {'ask' | 'print' | 'none'}
 */
export function relayOfferAtInit({ enabled, shared, environment = environmentAdapter().all(), stdin, stdout }) {
  if (!enabled || shared) return 'none';
  if (AGENT_SHELL_MARKERS.some((name) => Boolean(environment[name]))) return 'print';
  if (continuousIntegration(environment) || remoteShell(environment)) return 'print';
  return stdin?.isTTY && stdout?.isTTY ? 'ask' : 'print';
}

/**
 * Whether an answer to the sharing question is yes: Enter, y or yes. No answer at all, as when
 * the terminal closes, is no.
 *
 * @param {string | null} answer
 * @returns {boolean}
 */
export function acceptsRelayOffer(answer) {
  return answer !== null && ['', 'y', 'yes'].includes(answer.trim().toLowerCase());
}
