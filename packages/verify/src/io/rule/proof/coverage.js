/** Committed rule coverage is derived on the event writer, never by status or API readers [S1,C7]. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tryGit } from '../../../../../git/index.js';
import { literalShellWords } from '../../../../../kernel/index.js';
const FILE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:[cm]?js|cts)$/u;

let runnerFile = null;

/**
 * Name the installed canonical test runner file. The composition root above verify supplies it, so this package never imports the runner's cell.
 * Until it is named, coverage stays unknown (never guessed) and the fingerprint differs from any bound reader's.
 */
export function bindProofRunner(file) {
  runnerFile = typeof file === 'string' && file ? file : null;
}

/** The installed runner's bytes, or null while no runner is bound or it cannot be read. */
function runnerBytes() {
  try { return runnerFile === null ? null : readFileSync(runnerFile); } catch { return null; }
}

/** Bind cached interpretation to installed parser and canonical runner bytes, independent of reader runtime. */
export function proofCoverageFingerprint() {
  const hash = createHash('sha256').update('rule-coverage-source-v2');
  // The hashed names keep their historical spelling; each literal URL names the file where it now lives.
  hash.update('./coverage.js').update(readFileSync(new URL('./coverage.js', import.meta.url)));
  hash.update('./literal-shell-words.js').update(readFileSync(new URL('../../../../../kernel/src/logic/words.js', import.meta.url)));
  hash.update('../bin/run-tests.js').update(runnerBytes() ?? 'runner-unbound');
  return hash.digest('hex');
}

/** Parse one literal Node test selection without pretending filtered, sharded or unknown options ran the file. */
function selectedFiles(args, tracked, canonical) {
  const files = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (/^--test-concurrency=\d+$/u.test(arg)) continue;
    if (arg === '--test-concurrency') { if (!/^\d+$/u.test(args[++at] ?? '')) return []; continue; }
    if (arg.startsWith('-')) return [];
    const file = arg.replace(/^\.\//u, '');
    if (!FILE.test(file) || !tracked.has(file)) return [];
    files.push(file);
  }
  // The canonical runner deliberately selects tracked .test.js/.test.mjs entry points, not helper modules.
  if (!files.length) return canonical ? [...tracked]
    .filter(file => !file.split('/').some(part => part === 'node_modules' || part.startsWith('.')))
    .filter(file => /(?:^|\/)[^/]+\.test\.(?:js|mjs)$/u.test(file)) : [];
  return files;
}

/** Recognize only option-free npm test and npm run script commands; options leave the gate opaque. */
function npmScriptName(words) {
  if (words?.[0] !== 'npm') return null;
  if (words[1] === 'test' && words.length === 2) return 'test';
  return words[1] === 'run' && words.length === 3 && words[2] && !words[2].startsWith('-') ? words[2] : null;
}

/** Known external tools leave the parent shell's directory/environment intact; shell builtins do not. */
function keepsShellContext(words) {
  return words && (words[0] === 'node' || words[0] === process.execPath
    || npmScriptName(words) !== null);
}

/** Resolve supported configured test commands at the receipt's committed source; opaque commands prove no file. */
function includedFiles(root, commit, command, tracked, depth = 0, context = {}) {
  if (depth > 4) return [];
  const words = literalShellWords(command);
  if (!words) {
    // A green AND chain proves its selected commands only if no earlier part changed the shell's cwd/environment.
    const parts = command.split(' && ');
    return parts.length > 1 && parts.every(part => keepsShellContext(literalShellWords(part)))
      ? parts.flatMap(part => includedFiles(root, commit, part, tracked, depth + 1, context)) : [];
  }
  if (npmScriptName(words) !== null) {
    try {
      const source = tryGit(root, ['show', `${commit}:package.json`]);
      const manifest = JSON.parse(source.stdout);
      if (Object.hasOwn(manifest, 'workspaces') || tracked.has('.npmrc')) return [];
      const script = manifest.scripts?.[npmScriptName(words)];
      return typeof script === 'string' ? includedFiles(root, commit, script, tracked, depth + 1, context) : [];
    } catch { return []; }
  }
  if (words[0] !== 'node' && words[0] !== process.execPath) return [];
  if (words[0] === process.execPath) context.execPath = process.execPath;
  if (words[1] === '--test') return selectedFiles(words.slice(2), tracked, false);
  const launcher = words[1]?.replace(/^\.\//u, '');
  if ((launcher === 'apps/cli/src/io/run/tests.js' || launcher === 'packages/gate/src/io/run/tests.js') && tracked.has(launcher)) {
    // A check frozen on the old path reaches the same launcher through the forwarding shim, so both compare the app file.
    const source = tryGit(root, ['show', `${commit}:apps/cli/src/io/run/tests.js`]);
    const installed = runnerBytes();
    if (source.status !== 0 || installed === null || source.stdout !== installed.toString('utf8')) return [];
    return selectedFiles(words.slice(2), tracked, true);
  }
  return [];
}

/** Resolve one immutable commit's policy/tree/coverage once; incomplete source remains unknown. */
export function committedRuleCoverage(root, head) {
  try {
    const configResult = tryGit(root, ['show', `${head}:pullboard.json`]);
    if (configResult.status !== 0) return null;
    const config = JSON.parse(configResult.stdout);
    if (typeof config.gate !== 'string' || !config.gate.trim()) return null;
    const tree = tryGit(root, ['rev-parse', `${head}^{tree}`]);
    const entries = tryGit(root, ['ls-tree', '-rz', head]);
    if (tree.status !== 0 || entries.status !== 0) return null;
    const tracked = new Set(entries.stdout.split('\0').filter(entry => /^(?:100644|100755) blob /u.test(entry))
      .map(entry => entry.slice(entry.indexOf('\t') + 1)));
    const context = {};
    const files = [...new Set(includedFiles(root, head, config.gate, tracked, 0, context))];
    return { head, tree: tree.stdout.trim(), command: createHash('sha256').update(config.gate).digest('hex'),
      fingerprint: proofCoverageFingerprint(), runtime: context.execPath ?? null, files };
  } catch { return null; }
}
