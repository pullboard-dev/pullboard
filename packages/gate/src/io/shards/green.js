/**
 * A builder's green `pullboard test` run kept as the gate's proof of the same files at the same tree, so the item check
 * and the proof batches take it instead of a second runner trip for the same bytes [C7].
 *
 * Why: the 10HA trial (11 Nov) paid two or three runner round trips per item for one check file: pullboard test (~100 s),
 * pullboard check --yes (~250 s), then the gate ran it a third time. Reuse is exact: the same tree, the same runner
 * command and file set, and the same runner tooling; anything else runs again.
 */
import { posix } from 'node:path';
import { tryGit } from '../../../../git/index.js';
import { shardPassStore } from './proof.js';

/** Recorded runs past this size run again rather than fill the machine home. */
const MAX_OUTPUT = 4 * 1024 * 1024;
const TOOLING = /^[0-9a-f]{64}$/u;
const SHELL_SYNTAX = /[;&|<>`$()!\\\n'"*?]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;

/** The runner tooling sha256 a run carries, or null. */
function toolingOf(run) {
  const sha = run?.executionSource?.tooling?.sha256;
  return typeof sha === 'string' && TOOLING.test(sha) ? sha : null;
}

/** The files command prefix the gate appends `./file` words to, from a runner command such as `node <runner>`. */
function filesCommandPrefix(runner) { return `${String(runner ?? '').trimEnd()} `; }

/**
 * The runner and test files of a frozen check that is exactly `<program> <runner script> <test files…>`, or null for any
 * other command: shell syntax, options, a negation, or a word that is not a test file.
 *
 * @param {string} check
 * @returns {{ runner: string, files: string[] } | null}
 */
export function plainCheckRun(check) {
  const text = String(check ?? '').trim();
  if (!text || SHELL_SYNTAX.test(text)) return null;
  const words = text.split(/\s+/u);
  const files = words.slice(2).map(word => word.replace(/^\.\//u, ''));
  if (words.length < 3 || !files.every(file => TEST_FILE.test(file))) return null;
  return { runner: words.slice(0, 2).join(' '), files };
}

/**
 * Record a green named-file run for its exact tree, command and tooling. Only a completed runner run whose source tree
 * and tooling are known is kept; a red, a local run or an oversized output records nothing.
 *
 * @param {object} run - The run as the runner returned it (isGreen, exitCode, output, executionSource, environment…).
 * @param {{ runner: string, files: string[], timingRunId?: string|null, folder?: string }} options
 * @returns {boolean} Whether the run was recorded.
 */
export function recordGreenRun(run, { runner, files, timingRunId = null, folder } = {}) {
  const tree = run?.executionSource?.tree;
  if (run?.isGreen !== true || run.exitCode !== 0 || !toolingOf(run) || !Array.isArray(files) || !files.length
    || typeof run.output !== 'string' || run.output.length > MAX_OUTPUT) return false;
  const passes = shardPassStore(tree, filesCommandPrefix(runner), folder ? { folder } : {});
  if (!passes) return false;
  const kept = { isGreen: true, exitCode: 0, output: run.output, environment: run.environment ?? null, testRuntimes: run.testRuntimes ?? null,
    executionRunner: run.executionRunner ?? null, executionRoot: run.executionRoot ?? null, executionSource: run.executionSource,
    remoteWallMs: run.remoteWallMs ?? null, seconds: run.seconds ?? null };
  passes.record({ files: [...files], run: kept, timingRunId, at: Date.now() });
  return true;
}

/**
 * The recorded green run of exactly `files` at `tree` by `runner` with the same runner tooling, rebound to this run's
 * timing id and candidate head, or null. The tree is the content identity; the head is rebound only when the trees are
 * equal, and the output's first line names the run reused.
 *
 * @param {{ tree: string, head: string, runner: string, files: string[], tooling: string|null, timingRunId?: string|null, folder?: string }} wanted
 * @returns {object|null}
 */
export function reusableGreenRun({ tree, head, runner, files, tooling, timingRunId = null, folder }) {
  if (!tooling || !TOOLING.test(tooling) || !Array.isArray(files) || !files.length) return null;
  const passes = shardPassStore(tree, filesCommandPrefix(runner), folder ? { folder } : {});
  if (!passes) return null;
  const wanted = [...new Set(files)].sort().join('\n');
  const pass = passes.read().filter(row => Array.isArray(row?.files) && [...new Set(row.files)].sort().join('\n') === wanted
    && row.run?.isGreen === true && row.run.exitCode === 0 && row.run.executionSource?.tree === tree && toolingOf(row.run) === tooling).at(-1);
  if (!pass) return null;
  const rebind = typeof pass.timingRunId === 'string' && pass.timingRunId && timingRunId && pass.timingRunId !== timingRunId;
  const output = rebind ? pass.run.output.replaceAll(pass.timingRunId, timingRunId) : pass.run.output;
  const from = `# reused green run ${pass.timingRunId ?? 'unknown'} of ${files.length} file(s) at tree ${tree.slice(0, 12)}, commit ${String(pass.run.executionSource.commit ?? '').slice(0, 12)}, on ${pass.run.executionRunner ?? 'a runner'}\n`;
  return { ...pass.run, output: from + output, executionSource: { ...pass.run.executionSource, commit: head ?? pass.run.executionSource.commit }, reusedGreen: true };
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;

/**
 * Every repo file the test files import, directly or through each other, with the test files themselves; a path no reader
 * returns text for stays in the set, so an unreadable import is never assumed untouched.
 *
 * @param {string[]} files
 * @param {(path: string) => string|null} read - The file's text at the earlier tree, or null.
 * @returns {Set<string>}
 */
export function importClosure(files, read) {
  const seen = new Set(), queue = [...files];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?js$/u.test(file)) continue;
    const text = read(file);
    if (text === null) continue;
    for (const match of text.matchAll(IMPORT_SPECIFIER)) queue.push(posix.normalize(posix.join(posix.dirname(file), match[1])));
  }
  return seen;
}

/**
 * The recorded green run at the tree a merge of main started from, when the merge changed no file the check's files import.
 * Why: submit merges main when it moved, so the tree differs from the one the builder's run proved; a merge that touches
 * nothing in the import closure (or the test files) cannot change that run's outcome, so it stays the proof [C7].
 *
 * @param {string} root
 * @param {{ tree: string, head: string, runner: string, files: string[], tooling: string|null, timingRunId?: string|null, folder?: string }} wanted - The merged tree and head.
 * @param {{ git?: (root: string, args: string[]) => string|null }} [options]
 * @returns {object|null}
 */
export function reusableAcrossMerge(root, wanted, { git = tryGit } = {}) {
  const parents = String(git(root, ['rev-list', '--parents', '-n', '1', wanted.head]) ?? '').trim().split(/\s+/u).slice(1);
  if (parents.length !== 2) return null;
  const priorTree = String(git(root, ['rev-parse', `${parents[0]}^{tree}`]) ?? '').trim();
  if (!priorTree || priorTree === wanted.tree) return null;
  const run = reusableGreenRun({ ...wanted, tree: priorTree });
  if (!run) return null;
  const changed = git(root, ['diff', '--name-only', priorTree, wanted.tree]);
  if (changed === null) return null;
  const closure = importClosure(wanted.files, path => git(root, ['show', `${priorTree}:${path}`]));
  return changed.split('\n').filter(Boolean).some(path => closure.has(path)) ? null : run;
}

/** The recorded green run at exactly this tree, else the one a main merge left untouched, else null [C7]. */
export function reusableProof(root, wanted, options) { return reusableGreenRun(wanted) ?? reusableAcrossMerge(root, wanted, options); }
