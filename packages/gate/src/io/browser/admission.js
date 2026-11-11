/**
 * Browser admission reads one declaration: a test file needs a browser only when its first line is
 * `// pullboard: browser` [C7]. Nothing here parses imports or guesses from source; a frozen check is parsed
 * only to name the explicit test files it runs, and an opaque command keeps browser capacity.
 */
import {
  accessSync,
  constants,
} from 'node:fs';
import {
  lstat,
  readFile,
  realpath,
} from 'node:fs/promises';
import {
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  cleanGitEnvironment,
  git,
} from '../../../../git/index.js';
import { literalShellWords } from '../../../../kernel/index.js';
import { foreignNodeOptions } from '../test/isolation.js';
import { declaresBrowser } from '../../logic/declaration.js';

const TEST_RUNNER = 'apps/cli/src/io/run/tests.js';
/** Fixed source-only entry points belong to this tool's repository, never to a project's labels. */
const SOURCE_CHECKS = [
  { args: ['apps/cli/src/io/static/checks.js'], file: 'apps/cli/src/io/static/checks.js', doctrine: true },
  { args: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'apps/cli/src/io/static/checks.js'], file: 'apps/cli/src/io/static/checks.js', doctrine: true },
  { args: ['apps/cli/pullboard.js', 'doctrine', 'check'], file: 'apps/cli/pullboard.js', doctrine: true },
  { args: ['apps/cli/pullboard.js', 'spec', 'check'], file: 'apps/cli/pullboard.js' },
  { args: ['packages/gate/src/io/file/size.js'], file: 'packages/gate/src/io/file/size.js' },
  { args: ['packages/gate/src/io/catch.js'], file: 'packages/gate/src/io/catch.js' },
  { args: ['packages/gate/src/io/test/names.js'], file: 'packages/gate/src/io/test/names.js' },
  { args: ['packages/gate/src/io/test/inputs.js'], file: 'packages/gate/src/io/test/inputs.js' },
  { args: ['apps/cli/src/io/static/view.js'], file: 'apps/cli/src/io/static/view.js' },
];
const DOCTRINE_CHECKS = new Set(['packages/gate/src/io/file/size.js', 'packages/gate/src/io/catch.js', 'packages/gate/src/io/test/names.js', 'packages/gate/src/io/test/inputs.js']);
const VALUE_OPTIONS = new Set(['--test-concurrency', '--test-name-pattern', '--test-shard', '--test-skip-pattern', '--test-timeout']);
const FLAG_OPTIONS = new Set(['--test-only']);

export { BROWSER_MARKER } from '../../logic/declaration.js';

export { literalShellWords } from '../../../../kernel/index.js';

/** Parse only explicit Node test-runner files and the small, literal option set used by frozen checks. */
function explicitRunnerFiles(args) {
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith('-')) {
      const separator = argument.indexOf('=');
      const name = separator < 0 ? argument : argument.slice(0, separator);
      if (VALUE_OPTIONS.has(name)) {
        if (separator < 0 && ++index >= args.length) return null;
        if (separator >= 0 && !argument.slice(separator + 1)) return null;
        continue;
      }
      if (FLAG_OPTIONS.has(name) && separator < 0) continue;
      return null;
    }
    files.push(argument);
  }
  return files.length && files.every(file => !file.split('/').some(part => part === '.' || part === '..')
    && /^(?:test|(?:packages|apps)\/[^/]+\/(?:tests|journeys))\/.+\.test\.(?:js|mjs|cjs|cts)$/u.test(file)) ? files : null;
}

/** Resolve a command word through PATH using the same inherited environment as the check shell.
 * @param {string} command
 * @param {string | undefined} pathValue
 * @returns {string | null}
 */
export function resolveExecutable(command, pathValue = process.env.PATH) {
  if (command.includes('/')) return resolve(command);
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (pathValue ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory || '.', command + suffix);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue through PATH */ }
    }
  }
  return null;
}

/** Recognize output-only status wrappers without treating arbitrary shell suffixes as classified work. */
function statusCaptureSuffix(suffix, variable) {
  if (variable === 'rc' || variable === 'bad') return false;
  const quotes = ['"', "'"];
  const prints = [1, 2].flatMap(slashes => quotes.map(quote => `printf ${quote}%s${'\\'.repeat(slashes)}n${quote} "$${variable}"`));
  for (const print of prints) {
    const saved = `; rc=$?; ${print}; `;
    if (suffix === `${saved}[ "$rc" -eq 0 ]`) return true;
    for (const badPrint of prints) for (const quote of quotes) {
      const checked = `${saved}bad=$(${badPrint} | grep -E ${quote}^# (fail|skipped) [1-9]${quote}); [ "$rc" -eq 0 ] && [ -z "$bad" ]`;
      if (suffix === checked) return true;
      for (const finalPrint of prints) for (const namedQuote of quotes) {
        const prefix = `${checked} && ${finalPrint} | grep -Eq ${namedQuote}`;
        if (!suffix.startsWith(prefix) || !suffix.endsWith(namedQuote)) continue;
        const pattern = suffix.slice(prefix.length, -1);
        if (pattern.startsWith('^[[:space:]]*ok [0-9]+ - ') && !/["'$`\\]/u.test(pattern)) return true;
      }
    }
  }
  return false;
}

/** Recognize fixed frozen-check wrappers; new status wrappers do not widen short-slot eligibility. */
function capturedRunner(command, { status = false } = {}) {
  const opening = /^([A-Za-z_][A-Za-z0-9_]*)=\$\(/u.exec(command);
  if (!opening) return null;
  const variable = opening[1];
  const ending = ' 2>&1)';
  const bodyEnd = command.indexOf(ending, opening[0].length);
  if (bodyEnd < 0) return null;
  const inner = command.slice(opening[0].length, bodyEnd);
  const suffix = command.slice(bodyEnd + ending.length);
  if (status && statusCaptureSuffix(suffix, variable)) return inner;
  const quotes = ['"', "'"];
  // Only the literal one-backslash newline form is part of the frozen capture shape.
  const prints = quotes.map(quote => `printf ${quote}%s\\n${quote} "$${variable}"`);
  for (const firstPrint of prints) for (const secondPrint of prints) {
    const prefix = `; ${firstPrint}; ${secondPrint} | grep -Eq `;
    if (!suffix.startsWith(prefix)) continue;
    for (const firstQuote of quotes) {
      const firstPatternStart = prefix + firstQuote;
      if (!suffix.startsWith(firstPatternStart)) continue;
      const remainder = suffix.slice(firstPatternStart.length);
      for (const lastPrint of prints) for (const lastQuote of quotes) {
        const separator = `${firstQuote} && ${lastPrint} | grep -Eq ${lastQuote}`;
        const split = remainder.indexOf(separator);
        if (split < 0 || !remainder.endsWith(lastQuote)) continue;
        const patterns = [remainder.slice(0, split), remainder.slice(split + separator.length, -1)];
        if (patterns[0].startsWith('^[[:space:]]*ok [0-9]+ - ') && !patterns[0].includes('$')
          && patterns[1] === '^# fail 0$' && patterns.every(pattern => !/["'\\`]/u.test(pattern))) return inner;
      }
    }
  }
  return null;
}

/** Read a commit's regular-file map so verification classifies only the submitted source tree. */
function committedFiles(root, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/iu.test(commit)) return null;
  let output;
  try {
    output = git(root, ['--no-replace-objects', '-c', 'core.quotepath=false', 'ls-tree', '-rz', '--full-tree', commit], {
      env: cleanGitEnvironment(), maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
  if (!output) return null;
  const files = new Map();
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const [mode, type, object] = record.slice(0, tab).split(' ');
    files.set(record.slice(tab + 1), { mode, type, object });
  }
  return files;
}

/** Read a regular committed blob, rejecting symlinks and non-file objects as uncertain. */
function committedSource(root, files, path) {
  const entry = files.get(path);
  if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) return null;
  try {
    return git(root, ['--no-replace-objects', 'cat-file', 'blob', entry.object], {
      env: cleanGitEnvironment(), maxBuffer: 16 * 1024 * 1024,
    });
  } catch { return null; }
}


/** Report a one-line explanation when uncertainty reserves browser capacity.
 * @param {(decision:{file:string,reason:string})=>void|undefined} onFallback
 * @param {string} file
 * @param {string} reason
 * @returns {true}
 */
function browserFallback(onFallback, file, reason) {
  onFallback?.({
    file: String(file).replace(/[\r\n\t]+/gu, ' '),
    reason: String(reason).replace(/[\r\n\t]+/gu, ' '),
  });
  return true;
}

/** Identify a real repository root and its shared Git directory without inherited Git selectors. */
async function sourceRepository(root) {
  const fields = git(root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
    env: cleanGitEnvironment(),
  }).split('\n');
  if (fields.length !== 2 || await realpath(fields[0]) !== await realpath(root)) return null;
  return realpath(fields[1]);
}

/** Require a regular committed entry or a non-symlink working entry contained in its repository. */
async function regularCheckSource(root, file, committed) {
  if (committed) return committedSource(root, committed, file) !== null;
  const absolute = resolve(root, file);
  const info = await lstat(absolute);
  return info.isFile() && !info.isSymbolicLink() && await staysInside(root, absolute);
}

/** Read the exact executable doctrine rules without running them; only the fixed readers qualify. */
async function sourceOnlyDoctrine(root, committed, commit, env) {
  const [{ configFromSource, loadConfig }, { parseSpec }, { checkRule }] = await Promise.all([
    import('../../../../config/light.js'), import('../../../../spec/light.js'), import('../../../../doctrine/index.js'),
  ]);
  const config = commit ? configFromSource(committedSource(root, committed, 'pullboard.json')) : loadConfig(root);
  let file = config.practice;
  if (['DOCTRINE.md', 'PRACTICE.md'].includes(file)) {
    const names = ['DOCTRINE.md', 'PRACTICE.md'].filter(name => committed.has(name));
    if (names.length !== 1) return false;
    [file] = names;
  }
  if (repositoryPath(root, file) !== file) return false;
  const source = committedSource(root, committed, file);
  if (source === null) return false;
  const parsed = parseSpec(source, { strictGrammarVersion: false });
  if (parsed.problems.length) return false;
  for (const row of parsed.rows.filter(row => row.status === 'approved')) {
    const rule = checkRule(row);
    if (!rule) {
      if (/^check(?:\s|$)/u.test(row.gate)) return false;
      continue;
    }
    const words = literalShellWords(rule.command);
    if (words?.length !== 2 || !DOCTRINE_CHECKS.has(words[1])) return false;
    const node = resolveExecutable(words[0], env.PATH);
    if (!node || await realpath(node) !== await realpath(process.execPath)) return false;
    if (!await regularCheckSource(root, words[1], commit ? committed : null)) return false;
  }
  return true;
}

/** Recognize only this tool's own fixed source commands; every uncertain identity keeps browser admission. */
async function ownSourceCheck(root, words, { commit, env }) {
  const known = SOURCE_CHECKS.find(entry => entry.args.length === words.length - 1
    && entry.args.every((word, index) => word === words[index + 1]));
  if (!known) return false;
  try {
    const node = resolveExecutable(words[0], env.PATH);
    if (!node || await realpath(node) !== await realpath(process.execPath)) return false;
    const own = await sourceRepository(resolve(import.meta.dirname, '../../../../..'));
    if (!own || own !== await sourceRepository(root)) return false;
    const revision = commit ?? git(root, ['rev-parse', '--verify', 'HEAD'], { env: cleanGitEnvironment() });
    const committed = committedFiles(root, revision);
    if (!committed || !await regularCheckSource(root, known.file, commit ? committed : null)) return false;
    return !known.doctrine || await sourceOnlyDoctrine(root, committed, commit, env);
  } catch {
    return false; // Missing, foreign or unreadable source must keep the existing browser-required fallback.
  }
}

/** Parse the frozen check and read its explicit test files' declarations, failing closed on unknown shell. */
export async function checkNeedsBrowser(root, command, { commit, env = process.env, onFallback } = {}) {
  if (foreignNodeOptions(env.NODE_OPTIONS, env)) return browserFallback(onFallback, '<frozen check>', 'NODE_OPTIONS may load an unclassified module');
  let words = literalShellWords(command);
  if (words && await ownSourceCheck(root, words, { commit, env })) return false;
  if (!words) {
    const inner = capturedRunner(command, { status: true });
    if (!inner) return browserFallback(onFallback, '<frozen check>', 'shell syntax is outside the supported literal capture form');
    const grep = resolveExecutable('grep', env.PATH);
    if (!grep || !['/usr/bin/grep', '/bin/grep'].includes(await realpath(grep).catch(() => ''))) return browserFallback(onFallback, '<frozen check>', 'capture wrapper does not resolve the system grep');
    words = literalShellWords(inner);
  }
  if (!words || words.length < 3) return browserFallback(onFallback, '<frozen check>', 'command is not an explicit Node test selection');
  const node = resolveExecutable(words[0], env.PATH);
  if (!node || await realpath(node).catch(() => '') !== await realpath(process.execPath).catch(() => '')) return browserFallback(onFallback, '<frozen check>', 'Node executable does not resolve to this runtime');
  const runner = resolve(root, words[1]);
  if (runner !== resolve(root, TEST_RUNNER)) return browserFallback(onFallback, '<frozen check>', 'runner is not apps/cli/src/io/run/tests.js in this repository');
  const files = explicitRunnerFiles(words.slice(2));
  if (!files) return browserFallback(onFallback, '<frozen check>', 'runner options or test selection are not statically understood');
  if (commit) {
    const committed = committedFiles(root, commit);
    const runnerEntry = committed?.get(TEST_RUNNER);
    if (!runnerEntry || runnerEntry.type !== 'blob' || !['100644', '100755'].includes(runnerEntry.mode)) return browserFallback(onFallback, TEST_RUNNER, 'committed runner is missing or is not a regular file');
    return testsNeedBrowser(root, files, { commit, onFallback });
  }
  if (await realpath(runner).catch(() => '') !== await realpath(resolve(root, TEST_RUNNER)).catch(() => '')) return browserFallback(onFallback, TEST_RUNNER, 'runner resolves outside the expected repository path');
  const runnerInfo = await lstat(runner).catch(() => null);
  let runnerInside = false;
  try { runnerInside = await staysInside(root, runner); } catch { /* Missing or unresolved runner is uncertain. */ }
  if (!runnerInfo?.isFile() || runnerInfo.isSymbolicLink() || !runnerInside) return browserFallback(onFallback, TEST_RUNNER, 'runner is not a regular in-repository file');
  return testsNeedBrowser(root, files, { onFallback });
}

/**
 * Name the test files a check runs when it is a literal apps/cli/src/io/run/tests.js call over regular in-repository
 * test files, or return null. Only such a check may take a short gate slot (gate.shortSlots); anything
 * uncertain, a directory or discovery included, stays an ordinary run. Kept apart from checkNeedsBrowser
 * so short-slot admission never changes how a check is classified for the browser.
 *
 * @param {string} root
 * @param {string} command
 * @param {{ commit?: string, env?: NodeJS.ProcessEnv }} [options] - commit reads the files from that tree
 * @returns {Promise<string[] | null>}
 */
export async function explicitCheckFiles(root, command, { commit, env = process.env } = {}) {
  if (foreignNodeOptions(env.NODE_OPTIONS, env)) return null;
  let words = literalShellWords(command);
  if (!words) {
    const inner = capturedRunner(command);
    const grep = inner ? resolveExecutable('grep', env.PATH) : null;
    if (!grep || !['/usr/bin/grep', '/bin/grep'].includes(await realpath(grep).catch(() => ''))) return null;
    words = literalShellWords(inner);
  }
  if (!words || words.length < 3) return null;
  const node = resolveExecutable(words[0], env.PATH);
  if (!node || await realpath(node).catch(() => '') !== await realpath(process.execPath).catch(() => '')) return null;
  if (resolve(root, words[1]) !== resolve(root, TEST_RUNNER)) return null;
  const files = explicitRunnerFiles(words.slice(2));
  if (!files) return null;
  if (commit) {
    const committed = committedFiles(root, commit);
    const regular = path => {
      const entry = committed?.get(path);
      return Boolean(entry) && entry.type === 'blob' && ['100644', '100755'].includes(entry.mode);
    };
    return [TEST_RUNNER, ...files].every(regular) ? files : null;
  }
  for (const path of [TEST_RUNNER, ...files]) {
    const absolute = resolve(root, path);
    const info = await lstat(absolute).catch(() => null);
    const inside = await staysInside(root, absolute).catch(() => false);
    if (!info?.isFile() || info.isSymbolicLink() || !inside) return null;
  }
  return files;
}

/** Convert an in-root absolute or relative selection to a normalized repository-relative path. */
function repositoryPath(root, file) {
  if (typeof file !== 'string' || !file) return null;
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, file);
  const rel = relative(absoluteRoot, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/** Check that a resolved path stays inside the real repository, including through symlinks. */
async function staysInside(root, absolute) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
  return realTarget.startsWith(realRoot + sep);
}

/**
 * Read one test file's source from the working tree or, with a committed tree, from that commit; null when
 * the path is not a regular in-repository file there.
 *
 * @param {string} root
 * @param {string} file
 * @param {Map<string, {mode:string,type:string,object:string}> | null} committed
 * @returns {Promise<string | null>}
 */
async function testSource(root, file, committed) {
  const path = repositoryPath(root, file);
  if (!path) return null;
  if (committed) return committedSource(root, committed, path);
  const absolute = resolve(root, path);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || !await staysInside(root, absolute).catch(() => false)) return null;
  return readFile(absolute, 'utf8').catch(() => null);
}

/**
 * Whether a selection of test files needs a browser: true when any named file declares it on its first line.
 * A full or empty selection, or a name that is not a regular in-repository file, keeps browser capacity,
 * since no declaration can be read for it.
 *
 * @param {string} root
 * @param {string[] | undefined} files
 * @param {{commit?:string, onFallback?:(decision:{file:string,reason:string})=>void}} [options] - commit reads that tree
 * @returns {Promise<boolean>}
 */
export async function testsNeedBrowser(root, files, { commit, onFallback } = {}) {
  if (!Array.isArray(files) || !files.length) return browserFallback(onFallback, '<test selection>', 'a full selection names no file to read a declaration from');
  const committed = commit ? committedFiles(root, commit) : null;
  if (commit && !committed) return browserFallback(onFallback, '<test selection>', 'committed tree is unavailable');
  for (const file of files) {
    const source = await testSource(root, file, committed);
    if (source === null) return browserFallback(onFallback, file, 'not a regular in-repository test file, so no declaration can be read');
    if (declaresBrowser(source)) return true;
  }
  return false;
}

/**
 * The files of a set that declare a browser on their first line; each is read on its own, as the runner
 * admits each test file. A file that cannot be read declares nothing.
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {Promise<string[]>}
 */
export async function browserBoundFiles(root, files) {
  const bound = [];
  for (const file of files) {
    const source = await testSource(root, file, null);
    if (source !== null && declaresBrowser(source)) bound.push(file);
  }
  return bound;
}
