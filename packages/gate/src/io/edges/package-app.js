/** Package-to-app edges: the apps each package file imports, spawns or reads, held by a per-file ceiling that only falls [CD12]. */
import { posix } from 'node:path';
import {
  lex,
  lineAt,
} from '../scan.js';

// A relative path string from a package file into an app's source, such as `../../../../apps/runner/src/io/shell.js`.
const RELATIVE_APP = /^(?:\.\.\/)+apps\/[^/\s]+\/[^\s$]*\.[cm]?js$/u;

/**
 * The apps a source names by a relative path string, wherever the string is used.
 * Why: a package that resolves an app file from its own folder couples to that app even when no import or repo-path call shows it.
 *
 * @param {string} file - Repo-relative path.
 * @param {string} source
 * @returns {{ to: string, line: number }[]}
 */
export function relativeAppPaths(file, source) {
  const found = [];
  for (const string of lex(source).strings) {
    if (!RELATIVE_APP.test(string.text)) continue;
    const joined = posix.normalize(posix.join(posix.dirname(file), string.text));
    const app = /^apps\/([^/]+)\//u.exec(joined)?.[1] ?? /apps\/([^/]+)\//u.exec(string.text)[1];
    found.push({ to: `apps/${app}`, line: lineAt(source, string.start) });
  }
  return found;
}

/**
 * Each package file's app edges, by static or dynamic import, spawn path or read path, first line per app.
 *
 * @param {string[]} names - Repo-relative source files to read; files outside packages/ are skipped.
 * @param {(file: string) => string} read
 * @param {(file: string, source: string) => { to: string, line: number }[]} edgesOf - The cell edge finder (imports and repo-path reaches).
 * @returns {Record<string, { to: string, line: number }[]>}
 */
export function packageAppReport(names, read, edgesOf) {
  const report = {};
  for (const file of names) {
    if (!file.startsWith('packages/')) continue;
    const source = read(file);
    if (!source.includes('apps/')) continue;
    const first = new Map();
    for (const edge of [...edgesOf(file, source), ...relativeAppPaths(file, source)]) {
      if (edge.to.startsWith('apps/') && !first.has(edge.to)) first.set(edge.to, edge.line);
    }
    if (first.size) report[file] = [...first].sort(([a], [b]) => a.localeCompare(b)).map(([to, line]) => ({ to, line }));
  }
  return report;
}

/**
 * Refuse each package file that reaches an app its ceiling row does not list; a plan declaration never allows one.
 *
 * @param {Record<string, { to: string, line: number }[]>} current - From packageAppReport.
 * @param {Record<string, string[]>} ceiling - The committed `packageApps` rows.
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function packageAppProblems(current, ceiling) {
  const problems = [];
  for (const [file, edges] of Object.entries(current)) {
    const allowed = ceiling[file] ?? [];
    for (const edge of edges.filter(row => !allowed.includes(row.to))) {
      problems.push({ path: file, line: edge.line, text: `package file reaches ${edge.to} by import, spawn or read path; apps import packages, one way (CD12): move this file into ${edge.to}, or have the app pass it in` });
    }
  }
  return problems;
}
