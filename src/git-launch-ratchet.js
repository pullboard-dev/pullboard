/** Report remaining literal Git launches, retaining a per-file ratchet during adapter conversion [C7]. */
import {
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
} from './js-lex.js';

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

/** Read JavaScript beneath src, excluding only the production adapter's actual process boundary. */
export function gitLaunchReport(root) {
  const files = {};
  /** Walk source files without following symlinks or searching dependencies. */
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (file === 'src/git-adapter.js') continue;
        const launches = gitLaunches(readFileSync(path, 'utf8'));
        if (launches.length) files[file] = launches;
      }
    }
  }
  walk(join(root, 'src'));
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
