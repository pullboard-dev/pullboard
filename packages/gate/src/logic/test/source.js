/** Bind observed test names to their receipt's committed project namespace, not fixture working directories [C7]. */
import { tryGit } from '../../../../git/index.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;

/** Resolve only observed paths, batched per commit; never scan all source files for a receipt. */
export function bindTestValueSources(root, runs) {
  const groups = new Map();
  const coverage = { unknownCommitReceipts: 0, untrackedFileExecutions: 0, nonTestFileExecutions: 0 };
  for (const run of runs) {
    if (!groups.has(run.commit)) groups.set(run.commit, new Set());
    for (const file of run.files.keys()) if (TEST_FILE.test(file)) groups.get(run.commit).add(file);
  }
  const bound = new Map();
  for (const [commit, paths] of groups) {
    if (!SHA.test(commit ?? '') || tryGit(root, ['cat-file', '-e', `${commit}^{commit}`]).status !== 0) { bound.set(commit, null); continue; }
    const files = new Set();
    const selected = [...paths];
    for (let at = 0; at < selected.length; at += 256) {
      const result = tryGit(root, ['ls-tree', '-z', commit, '--', ...selected.slice(at, at + 256).map(file => ':(literal)' + file)]);
      if (result.status !== 0) { bound.set(commit, null); break; }
      for (const row of result.stdout.split('\0')) {
        const match = /^100(?:644|755) blob [a-f0-9]+\t([^\0]+)$/u.exec(row);
        if (match) files.add(match[1]);
      }
    }
    if (!bound.has(commit)) bound.set(commit, files);
  }
  for (const run of runs) {
    const files = bound.get(run.commit);
    if (files === null) coverage.unknownCommitReceipts += 1;
    for (const [file, count] of run.files) {
      if (!TEST_FILE.test(file)) { coverage.nonTestFileExecutions += count; run.files.delete(file); }
      else if (!files?.has(file)) { if (files !== null) coverage.untrackedFileExecutions += count; run.files.delete(file); }
    }
    run.timings = run.timings.filter(row => run.files.has(row.file));
    run.tests = run.tests.filter(row => run.files.has(row.file));
  }
  return coverage;
}
