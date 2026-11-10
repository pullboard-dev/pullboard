/** Report remaining literal Git launches, with a per-file ratchet keyed by true location [C7]. */
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  relative,
} from 'node:path';
import {
  lex,
  lineAt,
} from "../../../../kernel/light.js";

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'tests', 'test']);
const ADAPTERS = new Set(['packages/git/index.js', 'packages/git/src/io/adapter.js']);
const PROCESS_NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'];

/** Find literal executable arguments in executable code, including namespace calls and imported aliases.
 * This migration report deliberately does not claim to detect shell strings or computed executables.
 */
export function gitLaunches(source) {
  const { code, strings } = lex(source);
  const names = new Set(PROCESS_NAMES);
  for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])node:child_process\2/gu)) {
    for (const binding of match[1].split(',')) {
      const [original, alias] = binding.trim().split(/\s+as\s+/u);
      if (names.has(original) && alias) names.add(alias);
    }
  }
  const calls = new RegExp(`\\b(${[...names].join('|')})\\s*\\(\\s*`, 'gu');
  const literals = new Map(strings.map(string => [string.start, string]));
  const result = [];
  for (const match of code.matchAll(calls)) {
    const argument = literals.get(match.index + match[0].length);
    if (argument?.text === 'git') result.push({ line: lineAt(source, match.index), api: match[1] });
  }
  return result;
}

/** Count every physical literal Git launch under src and packages at its true path; exclude only the adapter itself. */
export function gitLaunchReport(root) {
  const files = {};
  /** Walk production source without following symlinks, searching dependencies or counting test fixtures. */
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (ADAPTERS.has(file)) continue;
        const launches = gitLaunches(readFileSync(path, 'utf8'));
        if (launches.length) files[file] = launches;
      }
    }
  }
  for (const top of ['src', 'packages', 'apps']) if (existsSync(join(root, top))) walk(join(root, top));
  return { total: Object.values(files).reduce((sum, launches) => sum + launches.length, 0), files };
}

/** Refuse growth in any file, even if a removal elsewhere would hide it in the global count. */
export function gitLaunchGrowth(report, allowances) {
  return Object.entries(report.files).flatMap(([file, launches]) => launches.length > (allowances[file] ?? 0)
    ? [{ file, actual: launches.length, allowed: allowances[file] ?? 0 }] : []);
}

/** Lower the committed allowance to the current report, keeping its scope and original total.
 * The ratchet only falls: any per-file growth is returned instead of a baseline, so a moved or new
 * launch site must be routed through the Git adapter rather than recorded as a fresh allowance.
 */
export function loweredGitLaunchBaseline(report, baseline) {
  const growth = gitLaunchGrowth(report, baseline.files);
  if (growth.length) return { growth };
  const files = Object.fromEntries(Object.entries(report.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, launches]) => [file, launches.length]));
  return { growth, baseline: { ...baseline, files } };
}
