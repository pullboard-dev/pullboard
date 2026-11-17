/** Project gate detection and configuration, without executing the chosen command [I1,I2,A1]. */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  loadConfig,
} from '../../../config/index.js';
import { repoInfo } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import {
  LANGUAGE_ROWS,
  rowMatches,
} from '../logic/language-rows.js';

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/** Test-file globs per detected language [#3707]. */
const LANGUAGE_TESTS = Object.freeze({
  go: ['**/*_test.go'],
  rust: ['**/tests/*.rs'],
  python: ['**/test_*.py', '**/*_test.py'],
  php: ['**/*Test.php'],
  elixir: ['**/*_test.exs'],
  csharp: ['**/*Tests.cs', '**/*Test.cs'],
  cmake: ['**/*_test.c', '**/*_test.cpp', '**/test_*.c', '**/test_*.cpp'],
  make: [],
});

/**
 * Every ecosystem the project uses, each with its test command, in a fixed order, without running anything.
 * Why: a repo with several languages needs each one's tests in its gate, not only the first found [#3707].
 *
 * @param {string} root
 * @param {readonly object[]} [rows] extra ecosystem rows, in table order
 * @returns {{ language: string, command: string }[]}
 */
export function detectLanguages(root, rows = LANGUAGE_ROWS) {
  const found = [];
  const add = (language, command) => found.push({ language, command });
  const file = join(root, 'package.json');
  if (existsSync(file)) {
    try {
      const test = JSON.parse(readFileSync(file, 'utf8'))?.scripts?.test;
      if (typeof test === 'string' && test.trim() && test.trim() !== NPM_DEFAULT_TEST) add('node', 'npm test');
    } catch { /* An unreadable package does not hide another ecosystem. */ }
  }
  if (existsSync(join(root, 'go.mod'))) add('go', 'go test ./...');
  if (existsSync(join(root, 'Cargo.toml'))) add('rust', 'cargo test');
  let python = ['pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml', 'pyproject.toml', 'setup.py', 'requirements.txt'].some((name) => existsSync(join(root, name)));
  for (const [name, section] of [['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]) {
    if (!python && existsSync(join(root, name)) && readFileSync(join(root, name), 'utf8').includes(`[${section}]`)) python = true;
  }
  if (python) add('python', 'pytest');
  if (existsSync(join(root, 'composer.json'))) add('php', 'composer test');
  if (existsSync(join(root, 'mix.exs'))) add('elixir', 'mix test');
  if (readdirSync(root).some((name) => /\.(sln|csproj)$/iu.test(name))) add('csharp', 'dotnet test');
  if (existsSync(join(root, 'CMakeLists.txt'))) add('cmake', 'cmake -S . -B build && cmake --build build && ctest --test-dir build');
  if (rows.length) {
    const names = readdirSync(root);
    const contents = (name) => (names.includes(name) ? readFileSync(join(root, name), 'utf8') : null);
    for (const row of rows) {
      if (rowMatches(row, names, contents)) add(row.language, typeof row.command === 'function' ? row.command(names, contents) : row.command);
    }
  }
  for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
    if (!existsSync(join(root, name))) continue;
    if (makeHasTest(readFileSync(join(root, name), 'utf8'))) add('make', 'make test');
    break;
  }
  return found;
}

/** Detect an existing ecosystem's test command without executing it during setup; several join with &&. */
export function detectGate(root) {
  return detectLanguages(root).map((entry) => entry.command).join(' && ');
}

/** The test-file globs of every detected language, so a builder cannot pick the tests that judge it [#3707]. */
export function detectTestGlobs(root, rows = LANGUAGE_ROWS) {
  const rowTests = new Map(rows.map((row) => [row.language, row.tests ?? []]));
  return [...new Set(detectLanguages(root, rows).flatMap((entry) => LANGUAGE_TESTS[entry.language] ?? rowTests.get(entry.language) ?? []))];
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
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.gate = command;
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  io.result?.({ gate: command, file: CONFIG_FILE });
  io.say(`set the project gate to ${command}`);
  io.say(`Next: commit ${CONFIG_FILE}, then run pullboard gate.`);
  return 0;
}
