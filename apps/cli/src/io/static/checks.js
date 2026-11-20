#!/usr/bin/env node
/** The Pullboard repository's source-only preflight; no browser fixtures run [C7]. */
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { changedStaticFailures } from '../../../../../packages/gate/heavy.js';
import { recentReceipts } from '../../../../../packages/gate/heavy.js';
import { staticScopeFromEnv } from '../../../../../packages/gate/heavy.js';
import { tripOverheadReport } from '../../../../../packages/gate/heavy.js';
import { gateTripOverheadBudgetMs } from '../../../../../packages/config/index.js';
import { staticParallelMax as machineStaticParallelMax } from '../../../../../packages/config/index.js';
import { viewPureGate } from './view.js';

/**
 * The first real error line of a crashed child's stderr, with its first `at` location.
 * Why: the last line of a Node crash is the "Node.js vX" banner, which names no cause.
 */
export function crashLine(stderr) {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean);
  const error = lines.find(line => /^\w*Error\b/.test(line)) ?? lines.find(line => !/^Node\.js v/.test(line)) ?? 'no output';
  const at = lines.find(line => line.startsWith('at '));
  return at ? `${error} (${at})` : error;
}

/**
 * Runs the independent static check classes concurrently and joins their findings in the order the classes are listed.
 * Why: the registry child and the view-pure scan share no state, so the gate pays the longer of them, not the sum; the
 * fixed join order keeps the printed findings stable however the classes finish [7089].
 * @param {Array<() => Promise<string[]>>} classes each returns its findings as lines
 * @returns {Promise<string[]>}
 */
export async function staticFailures(classes) {
  const started = classes.map(run => run());
  return (await Promise.all(started)).flat();
}

/** Report text from clean children, printed only when the whole stage is green [#8469]. */
const reports = [];

/**
 * Turn a finished registry child into its finding lines. A clean child's stderr is a report (sizes, never findings): it is held
 * and printed apart from the findings [#8460,#8469]; a failed child is one finding naming its cause.
 *
 * @param {number|null} status - The child's exit status.
 * @param {string} stdout - Its JSON findings.
 * @param {string} stderr - Its report text, or its crash output.
 * @returns {string[]}
 */
export function registryFindings(status, stdout, stderr) {
  if (status !== 0) return [`packages/gate/bin/static.js:1: the static tree registry could not run: ${crashLine(stderr)}`];
  if (stderr) reports.push(stderr);
  return JSON.parse(stdout);
}

/** The cap landing.staticParallelMax sets, or null when it is unset (or the machine settings cannot be read): the serial run [C7]. */
function staticParallelMax() {
  try { return machineStaticParallelMax(); } catch { return null; }
}

/** The static tree registry run as its own process; a crash is one failure line naming its cause [C7]. */
function treeRegistryFailures(program, root) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [...process.execArgv, '--input-type=module', '-e', program, root, JSON.stringify(staticScopeFromEnv()), JSON.stringify(STATIC_APPS), JSON.stringify(staticParallelMax())], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    // Report lines (sizes, never findings) arrive on a clean child's stderr; they are held and printed apart from the findings [#8460,#8469].
    child.on('error', error => resolveRun([`packages/gate/bin/static.js:1: the static tree registry could not run: ${error.message}`]));
    child.on('close', status => resolveRun(registryFindings(status, Buffer.concat(out).toString('utf8'), Buffer.concat(err).toString('utf8'))));
  });
}

/**
 * Print the findings, then the held reports only when there are no findings, and answer the stage's exit code.
 * Why: a report is information, so it follows the findings and never reads as the reason for a red [#8469].
 *
 * @param {string[]} failures - Every finding line of the stage.
 * @param {(text: string) => void} [write] - Where the lines go; stderr by default.
 * @returns {number} 1 when any finding exists, else 0.
 */
export function staticExitCode(failures, write = text => process.stderr.write(text)) {
  for (const row of failures) write(`${row}\n`);
  if (!failures.length) for (const text of reports) write(text);
  return failures.length ? 1 : 0;
}

/**
 * The CLI and relay paths the gate's tree registry reads, owned here so the gate names no app path [C7].
 * Why: the registry runs as its own process in the tree under test, so these paths travel to it as JSON.
 */
export const STATIC_APPS = Object.freeze({
  cliCell: 'apps/cli',
  cliIndex: 'apps/cli/index.js',
  cliHelp: 'apps/cli/src/logic/help.js',
  relayDeploy: 'apps/relay/src/io/deploy',
  specCheck: Object.freeze(['apps/cli/pullboard.js', 'spec', 'check']),
});

// Only the executable composes higher CLI services; importing this module does not run the preflight.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const root = process.cwd();
if (process.argv[2] === '--changed-files') {
  // One list for the gate and the pre-commit hook: packages/gate/src/io/changed/scripts/static.js.
  const failures = changedStaticFailures(root, process.argv.slice(3));
  if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
} else {
// The view-pure class needs the view app's test roles, so the CLI adds it here; gate's registry names no app [V32].
// Gate's tree registry runs as its own process, so this preflight imports nothing past gate's front doors [C7].
const registry = fileURLToPath(new URL('../../../../../packages/gate/src/io/static/registry.js', import.meta.url));
// A gate that found no whole-repo input in the change hands over the changed paths; the registry then judges only those [5814].
// landing.staticParallelMax (unset: serial) starts the registry's child-process checks together, at most that many at once [C7].
const program = `const { runStaticTreeRegistry, runStaticTreeRegistryParallel } = await import(${JSON.stringify(pathToFileURL(registry).href)});\nconst scope = { changed: JSON.parse(process.argv[2]), apps: JSON.parse(process.argv[3]) }, max = JSON.parse(process.argv[4]);\nprocess.stdout.write(JSON.stringify(max === null ? runStaticTreeRegistry(process.argv[1], scope) : await runStaticTreeRegistryParallel(process.argv[1], { ...scope, max })));`;
const failures = await staticFailures([
  () => treeRegistryFailures(program, root),
  async () => viewPureGate(root).failures.map(row => `${row.path}:${row.line}: ${row.text}`),
]);
const failed = staticExitCode(failures) !== 0;
// Report only: a runner trip over its overhead budget is printed with its runner and trip, and never turns this stage red [C7].
try { for (const line of tripOverheadReport(recentReceipts(root), gateTripOverheadBudgetMs())) console.log(line); } catch { /* No receipt log yet: nothing to report. */ }
if (!failed) console.log('static style, prose declarations, clock budgets and doctrine hold');
process.exitCode = failed ? 1 : 0;
}
}
