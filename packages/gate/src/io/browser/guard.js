/**
 * The run-time enforcement of browser declarations [C7]: a test file whose first line is not
 * `// pullboard: browser` runs without a browser lease (PULLBOARD_TEST_BROWSER_SLOT=none) and fails
 * BROWSER_UNDECLARED by name when it launches Chrome through the shared launcher (apps/cli/tests/fixtures/chrome.js),
 * which checks the lease itself.
 *
 * This module is a best-effort second guard for direct launches. The runner imports it in each
 * undeclared test file's process before the test body, and puts it in NODE_OPTIONS so Node children
 * that inherit that environment install it too. A child that strips its environment, a non-Node child,
 * or a shell running a script file is out of scope and not caught (docs/api.md). Installed, it wraps
 * node:child_process's spawn, spawnSync, exec, execSync, execFile, execFileSync and fork: a call whose
 * executable is a browser (Chrome's known install paths, PULLBOARD_CHROME's value, or a browser basename,
 * directly, through PATH or inside a shell command string) throws BROWSER_UNDECLARED naming the file,
 * before anything starts. apps/cli/tests/fixtures/chrome.js keeps its own check at the launch point as a second layer.
 * Without the marker, importing this module changes nothing.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  basename,
  delimiter,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { Refused } from '../../../../kernel/index.js';
import { BROWSER_MARKER } from '../../logic/declaration.js';
import { environmentAdapter } from '../../../../env/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

// Node registers this symbol globally; looking it up needs no util facade or dynamic loader.
const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');

/** The marker the runner sets in a test file's process: held, none, or unset when the setting is off. */
export const BROWSER_SLOT_ENV = 'PULLBOARD_TEST_BROWSER_SLOT';
/** Install paths apps/cli/tests/fixtures/chrome.js's findChromeExecutable looks in, besides PULLBOARD_CHROME. */
const KNOWN_BROWSERS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
/** Executable names that are a browser wherever they live. */
const BROWSER_NAME = /^(?:chrome|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable)?|headless_shell|chrome-headless-shell|google chrome(?: for testing| canary)?)(?:\.exe)?$/iu;
/** Shells whose -c argument is a command string this guard reads word by word. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const INSTALLED = Symbol.for('pullboard.browserSlotGuard');

/**
 * The refusal for a browser launch from a test file that did not declare one, naming the file the runner
 * recorded and the one-line fix.
 *
 * @param {string} what - what was started, for the message
 * @returns {Refused}
 */
export function browserSlotRefusal(what) {
  const testFile = environmentAdapter().get('PULLBOARD_TEST_FILE');
  const absolute = testFile ? resolve(testFile) : '';
  const local = absolute ? relative(process.cwd(), absolute) : '';
  const file = !absolute ? 'this test file' : (local && !local.startsWith('..') && !isAbsolute(local) ? local : absolute).split('\\').join('/');
  return new Refused('BROWSER_UNDECLARED', `${file} launched Chrome (${what}) without declaring it, so it holds no browser lease; make its first line ${BROWSER_MARKER}`,
    `make the first line of ${file} ${BROWSER_MARKER}, then run it again`);
}

/** A path with symlinks resolved when it exists, so a link to Chrome still reads as Chrome. */
function canonical(path) {
  try { return fs.realpath(path); } catch { return resolve(path); }
}

/** Find a bare command through PATH the way the spawn would, or null when it is not there. */
function onPath(command, pathValue) {
  for (const directory of String(pathValue ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', command);
    try { if (fs.stat(candidate).isFile()) return candidate; } catch { /* not in this PATH entry */ }
  }
  return null;
}

/**
 * Whether one executable word names a browser: by basename, by PATH, or as PULLBOARD_CHROME's value or a
 * known install path once symlinks are resolved.
 *
 * @param {unknown} word
 * @param {{cwd?: string | URL, env?: Record<string, string | undefined>}} [options]
 * @returns {boolean}
 */
export function isBrowserExecutable(word, { cwd, env } = {}) {
  if (typeof word !== 'string' && !(word instanceof URL)) return false;
  const text = word instanceof URL ? word.pathname : word;
  if (!text) return false;
  if (BROWSER_NAME.test(basename(text))) return true;
  const base = cwd instanceof URL ? cwd.pathname : (cwd ?? process.cwd());
  const path = text.includes('/') ? resolve(String(base), text) : onPath(text, env?.PATH ?? environmentAdapter().get('PATH'));
  if (!path) return false;
  const real = canonical(path);
  if (BROWSER_NAME.test(basename(real))) return true;
  const targets = [environmentAdapter().get('PULLBOARD_CHROME'), env?.PULLBOARD_CHROME, ...KNOWN_BROWSERS].filter(Boolean).map(canonical);
  return targets.includes(real);
}

/**
 * The words of a shell command string, quotes removed, split at blanks and shell operators. A reference
 * to $PULLBOARD_CHROME expands to its value. It errs toward finding a browser, never toward missing one.
 *
 * @param {string} command
 * @returns {string[]}
 */
function shellWords(command) {
  const chrome = environmentAdapter().get('PULLBOARD_CHROME', '');
  const expanded = String(command).replace(/\$\{PULLBOARD_CHROME\}|\$PULLBOARD_CHROME\b/gu, () => (chrome ? `'${chrome}'` : 'google-chrome'));
  const words = [];
  let word = '';
  let quote = '';
  for (const character of expanded) {
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/[\s;&|()<>`]/u.test(character)) { if (word) words.push(word); word = ''; }
    else if (character !== '\\') word += character;
  }
  if (word) words.push(word);
  return words;
}

/** Whether a shell command string starts a browser in any word position. */
function shellStartsBrowser(command, options) {
  return shellWords(command).some(word => isBrowserExecutable(word, options));
}

/**
 * What browser a child_process call would start, or null: the executable itself, a shell's -c string,
 * a command run with shell: true, or fork's execPath.
 *
 * @param {string} method
 * @param {unknown[]} input
 * @returns {string | null}
 */
export function browserInCall(method, input) {
  const [first, second, third] = input;
  if (method === 'exec' || method === 'execSync') {
    const options = second && typeof second === 'object' ? second : {};
    return typeof first === 'string' && shellStartsBrowser(first, options) ? first : null;
  }
  const args = Array.isArray(second) ? second.map(String) : [];
  const raw = Array.isArray(second) ? third : second;
  const options = raw && typeof raw === 'object' ? raw : {};
  if (method === 'fork') return options.execPath && isBrowserExecutable(options.execPath, options) ? String(options.execPath) : null;
  if (isBrowserExecutable(first, options)) return String(first);
  if (options.shell && shellStartsBrowser([first, ...args].join(' '), options)) return [first, ...args].join(' ');
  if (typeof first === 'string' && SHELLS.has(basename(first))) {
    const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/iu.test(arg));
    if (flag >= 0 && args[flag + 1] !== undefined && shellStartsBrowser(args[flag + 1], options)) return args[flag + 1];
  }
  if (typeof options.shell === 'string' && isBrowserExecutable(options.shell, options)) return options.shell;
  return null;
}

/**
 * Wrap node:child_process so an undeclared test file cannot start a browser, and publish the wrapped
 * functions to ES module importers. Idempotent; inert unless the marker says none.
 *
 * @returns {boolean} whether the guard is installed
 */
export function installBrowserSlotGuard() {
  if (environmentAdapter().get(BROWSER_SLOT_ENV) !== 'none') return false;
  if (globalThis[INSTALLED]) return true;
  globalThis[INSTALLED] = true;
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[method];
    /** Refuse a browser before the original call can start it; anything else runs unchanged. */
    const guarded = function guardedChildProcess(...input) {
      const browser = browserInCall(method, input);
      if (browser) throw browserSlotRefusal(browser);
      return original.apply(this, input);
    };
    const custom = original[PROMISIFY_CUSTOM];
    if (custom) {
      /** The promisified form takes the same arguments, so it gets the same check. */
      guarded[PROMISIFY_CUSTOM] = function guardedPromisified(...input) {
        const browser = browserInCall(method, input);
        if (browser) return Promise.reject(browserSlotRefusal(browser));
        return custom.apply(this, input);
      };
    }
    childProcess[method] = guarded;
  }
  syncBuiltinESMExports();
  return true;
}

installBrowserSlotGuard();
