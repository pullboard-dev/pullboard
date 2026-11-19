/** Project gate detection and configuration, without executing the chosen command [I1,I2,A1]. */
import { join } from 'node:path';
import {
  CONFIG_FILE,
  loadConfig,
} from '../../../config/index.js';
import { repoInfo } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import {
  LANGUAGE_ROWS,
  LANGUAGES,
  rowMatches,
} from '../logic/language-rows.js';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/**
 * The unittest command for a root with test_*.py files at its top or in a tests folder, else empty.
 * Why: discover skips a folder with no __init__.py, so a tests folder is named with -s [C7,#10366].
 *
 * @param {string} root
 * @returns {string}
 */
function unittestCommand(root) {
  const isTest = (name) => /^test_.*\.py$/u.test(name);
  if (fs.list(root).some(isTest)) return 'python3 -m unittest discover';
  const tests = join(root, 'tests');
  if (fs.exists(tests) && fs.list(tests).some(isTest)) return 'python3 -m unittest discover -s tests';
  return '';
}

/** Folders a nested scan never enters: tooling, dependencies and build output hold no project of their own [C7,#10367]. */
const NESTED_SKIPPED = new Set(['node_modules', 'vendor', 'target']);

/**
 * Every ecosystem the project uses, each with its test command, in a fixed order, without running anything.
 * Why: a repo with several languages needs each one's tests in its gate, not only the first found [#3707].
 * A root that detects nothing is read one folder down, each hit naming its folder, because a monorepo keeps
 * each service in its own folder; a root that detects anything is never scanned below [C7,#10367].
 *
 * @param {string} root
 * @param {readonly object[]} [rows] extra ecosystem rows, in table order
 * @returns {{ language: string, command: string, folder?: string }[]}
 */
export function detectLanguages(root, rows = LANGUAGE_ROWS) {
  const here = detectHere(root, rows);
  if (here.length) return here;
  const nested = [];
  const folders = fs.list(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NESTED_SKIPPED.has(entry.name))
    .map((entry) => entry.name).sort();
  for (const folder of folders) {
    for (const entry of detectHere(join(root, folder), rows)) nested.push({ ...entry, folder });
  }
  return nested;
}

/**
 * The ecosystems whose markers sit directly in one folder.
 *
 * @param {string} root
 * @param {readonly object[]} rows
 * @returns {{ language: string, command: string }[]}
 */
function detectHere(root, rows) {
  const found = [];
  const add = (language, command) => found.push({ language, command });
  const file = join(root, 'package.json');
  if (fs.exists(file)) {
    try {
      const test = JSON.parse(fs.readFile(file, 'utf8'))?.scripts?.test;
      if (typeof test === 'string' && test.trim() && test.trim() !== NPM_DEFAULT_TEST) add('node', 'npm test');
    } catch { /* An unreadable package does not hide another ecosystem. */ }
  }
  if (fs.exists(join(root, 'go.mod'))) add('go', 'go test ./...');
  if (fs.exists(join(root, 'Cargo.toml'))) add('rust', 'cargo test');
  let python = ['pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml', 'pyproject.toml', 'setup.py', 'requirements.txt'].some((name) => fs.exists(join(root, name)));
  for (const [name, section] of [['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]) {
    if (!python && fs.exists(join(root, name)) && fs.readFile(join(root, name), 'utf8').includes(`[${section}]`)) python = true;
  }
  // A uv or poetry project keeps pytest in its own environment, so a lock file beside pyproject.toml fronts the command (uv wins over poetry) [C7,#10357].
  const front = !fs.exists(join(root, 'pyproject.toml')) ? '' : fs.exists(join(root, 'uv.lock')) ? 'uv run ' : fs.exists(join(root, 'poetry.lock')) ? 'poetry run ' : '';
  if (python) add('python', `${front}pytest`);
  else {
    // A plain unittest repo has no marker file: a test_ file at the root or in tests/ is the whole signal [C7,#10366].
    const unittest = unittestCommand(root);
    if (unittest) add('python', unittest);
  }
  if (fs.exists(join(root, 'composer.json'))) add('php', 'composer test');
  if (fs.exists(join(root, 'mix.exs'))) add('elixir', 'mix test');
  if (fs.list(root).some((name) => /\.(sln|csproj)$/iu.test(name))) add('csharp', 'dotnet test');
  if (fs.exists(join(root, 'CMakeLists.txt'))) add('cmake', 'cmake -S . -B build && cmake --build build && ctest --test-dir build');
  if (rows.length) {
    const names = fs.list(root);
    // A name may reach into a folder (test/runtests.jl), so a missing or unreadable path is null rather than a throw.
    const contents = (name) => {
      try { return fs.readFile(join(root, name), 'utf8'); } catch { return null; }
    };
    for (const row of rows) {
      if (rowMatches(row, names, contents)) add(row.language, typeof row.command === 'function' ? row.command(names, contents) : row.command);
    }
  }
  for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
    if (!fs.exists(join(root, name))) continue;
    if (makeHasTest(fs.readFile(join(root, name), 'utf8'))) add('make', 'make test');
    break;
  }
  return found;
}

/** Detect an existing ecosystem's test command without executing it during setup; several join with &&. */
export function detectGate(root) {
  // A nested hit runs in a subshell that changes into its folder, so the next command starts where the gate did [C7,#10367].
  return detectLanguages(root).map((entry) => (entry.folder ? `(cd '${entry.folder.replaceAll("'", "'\\''")}' && ${entry.command})` : entry.command)).join(' && ');
}

/** The test-file globs of every detected language, so a builder cannot pick the tests that judge it [#3707]. */
export function detectTestGlobs(root, rows = LANGUAGE_ROWS) {
  // Built-in languages answer from LANGUAGES; the caller's rows answer the rest.
  const rowTests = new Map([...rows.map((row) => [row.language, row.tests ?? []]), ...LANGUAGES.filter((row) => row.detect === 'built-in').map((row) => [row.language, row.tests])]);
  const prefix = (entry) => (entry.folder ? `${entry.folder}/` : '');
  // A row's tests may be a function of the folder's entry names (ruby picks rspec or rake globs by what the folder holds).
  const globs = (entry) => {
    const tests = rowTests.get(entry.language) ?? [];
    return typeof tests === 'function' ? tests(fs.list(entry.folder ? join(root, entry.folder) : root)) : tests;
  };
  return [...new Set(detectLanguages(root, rows).flatMap((entry) => globs(entry).map((glob) => `${prefix(entry)}${glob}`)))];
}

/** Read literal rule target lists without executing Makefile parsing, includes or recipes. */
function makeHasTest(source) {
  return source.replace(/\\\r?\n/gu, ' ').split(/\r?\n/u).some((line) => {
    if (line.startsWith('\t')) return false;
    const targets = /^([^:#=]+):(?!(?::)*=)/u.exec(line)?.[1];
    return targets?.trim().split(/[ \t]+/u).includes('test') ?? false;
  });
}

/** Quote the whole gate command as one shell argument, including embedded quotes. */
export function settingCommand(root, command = detectGate(root) || 'pullboard spec check') {
  return `pullboard gate set '${command.replaceAll("'", "'\\''")}'`;
}

/** Refuse an empty gate with a project-specific next step rather than a substitute check. */
export function missingGate(root) {
  const next = `in the main checkout, run ${settingCommand(root)}, then commit ${CONFIG_FILE}`;
  return new Refused('NO_GATE', `no gate configured; ${next}`, next);
}

/** Set only the coordinator's gate field; running and trusting it remain separate commands. */
export function setHere(io, command, rest, values) {
  if (typeof command !== 'string' || !command.trim() || rest.length || values.landing) {
    throw new Refused('USAGE', 'set the gate with one quoted argument: pullboard gate set "<command>"', 'pullboard gate set "<command>"');
  }
  const info = repoInfo(io.cwd);
  if (!info.isMain) {
    throw new Refused('NOT_MAIN', 'the project gate belongs to the coordinator', 'ask the coordinator to run pullboard gate set "<command>" in the main checkout');
  }
  loadConfig(info.root);
  const file = join(info.root, CONFIG_FILE);
  const raw = JSON.parse(fs.readFile(file, 'utf8'));
  raw.gate = command;
  fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n');
  io.result?.({ gate: command, file: CONFIG_FILE });
  io.say(`set the project gate to ${command}`);
  io.say(`Next: commit ${CONFIG_FILE}, then run pullboard gate.`);
  return 0;
}

/* The runner toolchains each detected language needs, read from detectLanguages entries [C7]. */
/** The probe's toolchain name rule (packages/runners/src/io/probe.js), so every name here is one a runner can record. */
export const TOOLCHAIN_NAME = /^[a-z][a-z0-9+_-]{0,31}$/u;

/** Each language's toolchains, read from LANGUAGES; a function reads the detected command when the front tool varies (uv, poetry, bundle, rake, gradle, flutter). */
const toolchainsOf = (language) => LANGUAGES.find((row) => row.language === language)?.toolchains ?? null;

/**
 * The sorted unique toolchains a runner needs to test these detected languages, plus the languages no row knows.
 * Why: runners record toolchains and admission reads runners.requiredToolchains, but nothing maps a repo to what it needs,
 * so a Python job could be offered to a runner with no python3 and fail red instead of waiting for one that has it.
 *
 * @param {{ language: string, command?: string }[]} entries detectLanguages output
 * @returns {{ toolchains: string[], unknown: string[] }}
 */
export function languageToolchains(entries) {
  const toolchains = new Set();
  const unknown = new Set();
  for (const entry of entries ?? []) {
    const language = entry?.language;
    const row = typeof language === 'string' ? toolchainsOf(language) : null;
    if (row === null) {
      unknown.add(String(language));
      continue;
    }
    for (const name of typeof row === 'function' ? row(String(entry.command ?? '')) : row) toolchains.add(name);
  }
  return { toolchains: [...toolchains].sort(), unknown: [...unknown].sort() };
}

/** Every language with a toolchain row, sorted. */
export const TOOLCHAIN_LANGUAGES = Object.freeze(LANGUAGES.filter((row) => row.toolchains !== null).map((row) => row.language).sort());
