/** Classify whether selected tests may launch Chrome; uncertainty keeps browser coverage enabled. */
import {
  accessSync,
  constants,
} from 'node:fs';
import {
  lstat,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  commonJsIn,
  importsIn,
} from './module-imports.js';
import {
  cleanGitEnvironment,
  git,
} from './git.js';
import { literalShellWords } from './literal-shell-words.js';
import { foreignNodeOptions } from './test-isolation.js';
import { sourceLaunchesBrowser } from './browser-launch-source.js';

const MODULE_SUFFIXES = ['.js', '.mjs', '.cjs', '.cts', '.json'];
const CHROME_FIXTURE = 'test/chrome-fixture.js';
const FIXTURE_CHILD = 'test/fixture-child.js';
const JOURNEYS_TEST = 'test/journeys.test.js';
const TEST_RUNNER = 'bin/run-tests.js';
/** Fixed source-only entry points belong to this tool's repository, never to a project's labels. */
const SOURCE_CHECKS = [
  { args: ['bin/static-style-checks.js'], file: 'bin/static-style-checks.js', doctrine: true },
  { args: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'bin/static-style-checks.js'], file: 'bin/static-style-checks.js', doctrine: true },
  { args: ['bin/pullboard.js', 'doctrine', 'check'], file: 'bin/pullboard.js', doctrine: true },
  { args: ['bin/pullboard.js', 'spec', 'check'], file: 'bin/pullboard.js' },
  { args: ['bin/checks/file-size.js'], file: 'bin/checks/file-size.js' },
  { args: ['bin/checks/empty-catch.js'], file: 'bin/checks/empty-catch.js' },
  { args: ['bin/checks/test-names.js'], file: 'bin/checks/test-names.js' },
  { args: ['bin/checks/test-inputs.js'], file: 'bin/checks/test-inputs.js' },
];
const DOCTRINE_CHECKS = new Set(['bin/checks/file-size.js', 'bin/checks/empty-catch.js', 'bin/checks/test-names.js', 'bin/checks/test-inputs.js']);
/**
 * Chrome fixture exports that neither start a browser nor yield a browser path or launch arguments; any
 * other binding, findChromeExecutable and a new export included, counts as a launch. These six only work
 * over an existing DevTools connection, or refuse.
 */
const LAUNCH_FREE_CHROME_EXPORTS = new Set(['requireBrowserSlot', 'waitForTargetAbsent', 'createWaiter', 'createSender',
  'createEvaluator', 'createPageStepEvaluator']);
/** Imports that let a module start another process or module, which by launch counts only with a Chrome reference. */
const PROCESS_STARTERS = new Set(['node:child_process', 'node:worker_threads', 'node:cluster', 'node:module', 'node:vm']);
const VALUE_OPTIONS = new Set(['--test-concurrency', '--test-name-pattern', '--test-shard', '--test-skip-pattern', '--test-timeout']);
/** What module-imports reports for a dynamic import whose target is not one plain string. */
const COMPUTED_IMPORT = '(computed)';
const FLAG_OPTIONS = new Set(['--test-only']);
/** Path-scoped child-process exceptions with a short reason for each reviewed non-Chrome helper. */
const SAFE_CHILD_PROCESS_MODULES = new Map([
  ['test/fixture-child.js', 'shared fixture runner for explicit fixture commands'],
  ['src/git.js', 'runs Git commands for repository inspection'],
  ['src/module-imports.js', 'runs the Node parser in an isolated child'],
  ['src/resources.js', 'reads process identity with /bin/ps'],
]);
/** Reviewed generic executors and fixed Git/Node calls retain prior import behavior; all other calls stay conservative. */
const REVIEWED_EXECUTORS = new Map([
  ['src/cli.js', [{ function: 'sweepHere',
    site: "spawnSync(item.check, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })",
    reason: 'sweep runs the separately selected checker; importing the CLI does not select or run it' }]],
  ['src/sentinel-runner.js', [{ function: 'executeSentinel',
    site: "spawn(row.check, { cwd: directory, env: environment, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })",
    reason: 'the Windows sentinel executor runs an approved check only when explicitly invoked' }]],
  ['src/rigor-proof.js', [{ function: 'runOwnedCheck',
    site: "spawn(runner?.executable ?? '/bin/sh', runner?.args ?? ['-c', check], { cwd: tree, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'], })",
    reason: 'prepareCauseProof validates the named runner executable against the real process.execPath' }]],
  ['test/cli-startup.test.js', [{ function: 'fixture',
    site: "runFixtureChild(env.PULLBOARD_REAL_GIT, args, { cwd, env, encoding: 'utf8' })",
    reason: 'this private fixture binds PULLBOARD_REAL_GIT to realGitPath before installing its counting shim' }]],
  ['test/git-calls.test.js', [{ function: 'advanceHead',
    site: "execFileSync(box.env.PULLBOARD_REAL_GIT, ['commit-tree', tree, '-p', parent], { cwd: box.repo, env: box.env, input: label, encoding: 'utf8', })",
    reason: 'the private fixture binds this exact plumbing call to its realGit executable' }]],
]);

export { literalShellWords } from './literal-shell-words.js';

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
  return files.length && files.every(file => /^test\/.+\.test\.(?:js|mjs|cjs|cts)$/u.test(file)) ? files : null;
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

/** Resolve a module edge against a committed tree without following symlinks. */
function committedTarget(files, importer, request) {
  if (typeof request !== 'string' || !request.startsWith('.')) return null;
  const raw = request.split(/[?#]/u)[0];
  const base = posix.normalize(posix.join(posix.dirname(importer), raw));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = posix.extname(base) ? [base] : [base, ...MODULE_SUFFIXES.map(suffix => base + suffix), ...MODULE_SUFFIXES.map(suffix => posix.join(base, `index${suffix}`))];
  const found = candidates.filter(candidate => files.has(candidate));
  return found.length === 1 && ['100644', '100755'].includes(files.get(found[0]).mode) ? found[0] : null;
}

/** Allow only a side-effect fixture import or the fixed-Git helper; generic command helpers keep browser admission.
 * @param {string} source
 * @param {string} request
 * @returns {boolean}
 */
function safeFixtureChildImport(source, request) {
  const escaped = request.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const sideEffect = new RegExp(`^[ \\t]*import[ \\t]*(['"])${escaped}\\1[ \\t]*;?[ \\t]*$`, 'u');
  const fixedGit = new RegExp(`^[ \\t]*import[ \\t]*\\{[ \\t]*runFixtureGit(?:[ \\t]+as[ \\t]+[A-Za-z_$][\\w$]*)?[ \\t]*\\}[ \\t]*from[ \\t]*(['"])${escaped}\\1[ \\t]*;?[ \\t]*$`, 'u');
  let removedSafeImport = false;
  const remaining = source.split(/\r?\n/u).filter(line => {
    if (!line.includes(request)) return true;
    if (!sideEffect.test(line) && !fixedGit.test(line)) return true;
    removedSafeImport = true;
    return false;
  }).join('\n');
  if (!removedSafeImport) return false;
  try { return !importsIn([remaining])[0].includes(request); } catch { return false; }
}

/** By launch, a Chrome fixture import is launch-free only as single-line named imports of launch-free exports.
 * Anything else (a launch export, a namespace, default or dynamic import, a re-export of everything) is a launch.
 * @param {string} source
 * @param {string} request
 * @returns {boolean}
 */
function launchFreeChromeImport(source, request) {
  const escaped = request.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const named = new RegExp(`^[ \\t]*(?:import|export)[ \\t]*\\{([^}\\r\\n]*)\\}[ \\t]*from[ \\t]*(['"])${escaped}\\2[ \\t]*;?[ \\t]*$`, 'u');
  let removed = false;
  const remaining = source.split(/\r?\n/u).filter(line => {
    const match = named.exec(line);
    if (!match) return true;
    const names = match[1].split(',').map(part => part.trim()).filter(Boolean).map(part => part.split(/\s+as\s+/u)[0].trim());
    if (!names.length || !names.every(name => LAUNCH_FREE_CHROME_EXPORTS.has(name))) return true;
    removed = true;
    return false;
  }).join('\n');
  if (!removed) return false;
  try { return !importsIn([remaining])[0].includes(request); } catch { return false; }
}

/** Detect direct literal Chrome launchers without treating help text or refusal messages as launches. */
function namesChromeLauncher(source, path) {
  return sourceLaunchesBrowser(source, REVIEWED_EXECUTORS.get(path));
}

/** Detect dynamic process builtin access, which can load launch-capable modules.
 * @param {string} source
 * @returns {boolean}
 */
function usesDynamicBuiltinLoader(source) {
  const loaderName = ['getBuiltin', 'Module'].join('');
  if (source.includes(loaderName) || /getBuiltin\\u(?:004d|\{4d\})odule/iu.test(source)) return true;
  if (/\bprocess\s*(?:\?\.)?\s*\[\s*(?!(['"])env\1\s*\])/u.test(source)) return true;
  const aliases = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\b/gu)].map(match => match[1]);
  return aliases.some(alias => {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const computedAlias = new RegExp(`\\b${escapedAlias}\\s*(?:\\?\\.)?\\[\\s*(?!(['"])env\\1\\s*\\])`, 'u');
    return computedAlias.test(source);
  });
}

/**
 * Read gate.browserByLaunch; an unreadable settings file keeps today's broad classification, the safe side.
 * Loaded on demand: callers that pass byLaunch (the runner's per-file admission) never open settings.
 */
async function browserByLaunchSetting() {
  try { return (await import('./settings.js')).browserByLaunchEnabled(); } catch { return false; }
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
    import('./config.js'), import('./spec.js'), import('./doctrine-checks.js'),
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
    const own = await sourceRepository(resolve(import.meta.dirname, '..'));
    if (!own || own !== await sourceRepository(root)) return false;
    const revision = commit ?? git(root, ['rev-parse', '--verify', 'HEAD'], { env: cleanGitEnvironment() });
    const committed = committedFiles(root, revision);
    if (!committed || !await regularCheckSource(root, known.file, commit ? committed : null)) return false;
    return !known.doctrine || await sourceOnlyDoctrine(root, committed, commit, env);
  } catch {
    return false; // Missing, foreign or unreadable source must keep the existing browser-required fallback.
  }
}

/** Parse the frozen check and classify its explicit test files, failing closed on unknown shell. */
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
  if (runner !== resolve(root, TEST_RUNNER)) return browserFallback(onFallback, '<frozen check>', 'runner is not bin/run-tests.js in this repository');
  const files = explicitRunnerFiles(words.slice(2));
  if (!files) return browserFallback(onFallback, '<frozen check>', 'runner options or test selection are not statically understood');
  if (files.some(file => file === JOURNEYS_TEST || file === 'test/cockpit' || file.startsWith('test/cockpit/'))) return true;
  if (commit) {
    const committed = committedFiles(root, commit);
    const runnerEntry = committed?.get(TEST_RUNNER);
    if (!runnerEntry || runnerEntry.type !== 'blob' || !['100644', '100755'].includes(runnerEntry.mode)) return browserFallback(onFallback, TEST_RUNNER, 'committed runner is missing or is not a regular file');
    return testsNeedBrowserInTree(root, files, committed, onFallback);
  }
  if (await realpath(runner).catch(() => '') !== await realpath(resolve(root, TEST_RUNNER)).catch(() => '')) return browserFallback(onFallback, TEST_RUNNER, 'runner resolves outside the expected repository path');
  const runnerInfo = await lstat(runner).catch(() => null);
  let runnerInside = false;
  try { runnerInside = await staysInside(root, runner); } catch { /* Missing or unresolved runner is uncertain. */ }
  if (!runnerInfo?.isFile() || runnerInfo.isSymbolicLink() || !runnerInside) return browserFallback(onFallback, TEST_RUNNER, 'runner is not a regular in-repository file');
  return testsNeedBrowser(root, files, { onFallback });
}

/**
 * Name the test files a check runs when it is a literal bin/run-tests.js call over regular in-repository
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

/** Resolve one literal relative module request using file metadata, returning null when ambiguous. */
async function localTarget(root, importer, request) {
  if (typeof request !== 'string' || !request.startsWith('.')) return null;
  const raw = request.split(/[?#]/u)[0];
  const base = posix.normalize(posix.join(posix.dirname(importer), raw));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = posix.extname(base)
    ? [base]
    : [base, ...MODULE_SUFFIXES.map((suffix) => base + suffix), ...MODULE_SUFFIXES.map((suffix) => posix.join(base, `index${suffix}`))];
  const found = [];
  for (const candidate of candidates) {
    const absolute = resolve(root, ...candidate.split('/'));
    try {
      if (!(await staysInside(root, absolute))) return null;
      if ((await stat(absolute)).isFile()) found.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Parse each source's CommonJS use and imports once, in one child per batch, reusing earlier parses.
 * A source that loads CommonJS is never import-parsed, since the caller refuses it first.
 *
 * @param {string[]} sources
 * @param {Map<string, {commonJs:boolean, imports:string[]}>} memo
 * @returns {{commonJs:boolean, imports:string[]}[]}
 */
function parsedSources(sources, memo) {
  const fresh = [...new Set(sources.filter(source => !memo.has(source)))];
  if (fresh.length) {
    const commonJs = commonJsIn(fresh);
    const plain = fresh.filter((_, index) => !commonJs[index]);
    const imports = plain.length ? importsIn(plain) : [];
    fresh.forEach((source, index) => memo.set(source, { commonJs: commonJs[index], imports: [] }));
    plain.forEach((source, index) => { memo.get(source).imports = imports[index]; });
  }
  return sources.map(source => memo.get(source));
}

/**
 * Classify test imports from either the current checkout or one immutable committed tree.
 *
 * By default any path to the Chrome fixture, or any process or module starter the walk cannot follow,
 * reserves the browser. With byLaunch (machine setting gate.browserByLaunch) a file is browser-bound
 * only when its graph reaches a real launch: a Chrome fixture binding that starts Chrome, or a process
 * starter beside a Chrome executable reference. Cockpit files keep the browser until their own
 * fixture carries the BROWSER_SLOT_REQUIRED guard, and the guard at test/chrome-fixture.js's launch
 * point fails any launch the narrower walk misses.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {Map<string, {mode:string,type:string,object:string}> | null} committed
 * @param {((decision:{file:string,reason:string})=>void) | undefined} onFallback
 * @param {boolean} [byLaunch] - unset reads gate.browserByLaunch from this machine's settings
 * @param {Map<string, {commonJs:boolean, imports:string[]}>} [memo] - parses shared across one census of many files
 * @param {Map<string, boolean>} [launchFree] - Chrome fixture import verdicts shared the same way
 * @returns {Promise<boolean>}
 */
async function testsNeedBrowserInTree(root, files, committed = null, onFallback, byLaunch = undefined, memo = new Map(), launchFree = new Map()) {
  byLaunch ??= await browserByLaunchSetting();
  if (!Array.isArray(files) || files.length === 0) return browserFallback(onFallback, '<test selection>', 'selection is empty or unavailable');
  const normalized = files.map((file) => repositoryPath(root, file));
  if (normalized.some((file) => file === null)) return browserFallback(onFallback, '<test selection>', 'a selected path is outside the repository');
  if (normalized.some((file) => file === JOURNEYS_TEST || file === 'test/cockpit' || file.startsWith('test/cockpit/'))) return true;

  let frontier = [...new Set(normalized)];
  const seen = new Set();
  try {
    while (frontier.length) {
      const paths = [];
      const sources = [];
      for (const path of frontier) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (path === CHROME_FIXTURE && !byLaunch) return true;
        if (path.endsWith('.json')) continue;
        if (/\.(?:cjs|cts)$/u.test(path)) return browserFallback(onFallback, path, 'CommonJS loader behavior is not statically classified');
        paths.push(path);
        if (committed) {
          const source = committedSource(root, committed, path);
          if (source === null) return browserFallback(onFallback, path, 'committed source is missing or not a regular file');
          sources.push(source);
        } else {
          const absolute = resolve(root, ...path.split('/'));
          if (!(await staysInside(root, absolute))) return browserFallback(onFallback, path, 'live source resolves outside the repository');
          sources.push(await readFile(absolute, 'utf8'));
        }
      }
      if (!sources.length) break;
      const browserCalls = sources.map((source, index) => namesChromeLauncher(source, paths[index]));
      if (paths.some((path, index) => (path.startsWith('test/') || SAFE_CHILD_PROCESS_MODULES.has(path))
        && browserCalls[index])) return true;
      // By launch, a process or module starter launches a browser only beside a Chrome executable reference.
      const starts = sources.map(source => byLaunch && usesDynamicBuiltinLoader(source));
      const dynamicLoaderIndex = byLaunch ? -1 : sources.findIndex(usesDynamicBuiltinLoader);
      if (dynamicLoaderIndex >= 0) return browserFallback(onFallback, paths[dynamicLoaderIndex], 'dynamic process builtin loading can load an unclassified module');
      const commonJsIndex = parsedSources(sources, memo).findIndex(parsed => parsed.commonJs);
      if (commonJsIndex >= 0) return browserFallback(onFallback, paths[commonJsIndex], 'CommonJS loading is not statically classified');
      const imports = parsedSources(sources, memo).map(parsed => parsed.imports);
      const next = new Set();
      for (let index = 0; index < imports.length; index += 1) {
        for (const request of imports[index]) {
          if (byLaunch && PROCESS_STARTERS.has(request)) { starts[index] = true; continue; }
          if (request === 'node:child_process') {
            const policy = SAFE_CHILD_PROCESS_MODULES.get(paths[index]);
            if (!policy) return browserFallback(onFallback, paths[index], 'child_process use has no reviewed path-and-reason exception');
            continue;
          }
          if (request === 'node:module') return browserFallback(onFallback, paths[index], 'node:module can create a dynamic loader');
          if (request === 'node:worker_threads' || request === 'node:cluster') {
            return browserFallback(onFallback, paths[index], `${request} can launch an unclassified module`);
          }
          if (request === 'node:vm' && paths[index] !== 'src/module-imports.js') {
            return browserFallback(onFallback, paths[index], 'node:vm can evaluate an unclassified module');
          }
          if (request.startsWith('node:')) continue;
          if (byLaunch && request === COMPUTED_IMPORT) { starts[index] = true; continue; }
          if (!request.startsWith('.')) return browserFallback(onFallback, paths[index], `non-local import ${request} is not classified`);
          const target = committed
            ? committedTarget(committed, paths[index], request)
            : await localTarget(root, paths[index], request);
          if (!target) return browserFallback(onFallback, paths[index], `import ${request} is missing or ambiguous`);
          if (target === FIXTURE_CHILD && !safeFixtureChildImport(sources[index], request)) {
            if (byLaunch) starts[index] = true;
            else return browserFallback(onFallback, paths[index], 'fixture-child import exposes a generic caller-selected process target');
          }
          if (target === CHROME_FIXTURE) {
            if (!byLaunch) return true;
            const key = `${request}\0${sources[index]}`;
            if (!launchFree.has(key)) launchFree.set(key, launchFreeChromeImport(sources[index], request));
            if (!launchFree.get(key)) return true;
            continue;
          }
          if (!target.endsWith('.json') && !seen.has(target)) next.add(target);
        }
        if (starts[index] && browserCalls[index]) return true;
      }
      frontier = [...next];
    }
    return false;
  } catch {
    return browserFallback(onFallback, '<test selection>', 'source graph could not be inspected safely');
  }
}

/**
 * Return true for full or uncertain selections, cockpit tests, or imports reaching the Chrome fixture;
 * with byLaunch, only for cockpit tests, uncertain graphs and graphs that reach a real Chrome launch.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {{onFallback?:(decision:{file:string,reason:string})=>void, byLaunch?:boolean}} [options] - unset byLaunch reads gate.browserByLaunch
 * @returns {Promise<boolean>}
 */
export async function testsNeedBrowser(root, files, { onFallback, byLaunch } = {}) {
  return testsNeedBrowserInTree(root, files, null, onFallback, byLaunch);
}

/**
 * Classify each file on its own, as the runner admits each test file, sharing parses across the set.
 * This is the census behind gate.browserByLaunch: the files it returns are the ones that take a slot.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {{byLaunch?:boolean}} [options] - unset reads gate.browserByLaunch
 * @returns {Promise<string[]>}
 */
export async function browserBoundFiles(root, files, { byLaunch } = {}) {
  byLaunch ??= await browserByLaunchSetting();
  const memo = new Map();
  const launchFree = new Map();
  const bound = [];
  for (const file of files) {
    if (await testsNeedBrowserInTree(root, [file], null, undefined, byLaunch, memo, launchFree)) bound.push(file);
  }
  return bound;
}
