/** The files a landing derives after its item merges (engine numbers, format table, generated docs, plan placement), as one step a runner job can run [C7,#5568]. */
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../../../git/index.js';
import { gitSpawn } from '../../../git/index.js';
import { CLOSURE_CEILINGS } from '../../../gate/index.js';
import { assignEngineNumbers } from '../../../state/index.js';
import { writeFormatTable } from '../../../state/index.js';
import { GENERATED_DOC_PATHS } from '../../../merge/index.js';
import { refreshLandingDocs } from './docs.js';
import { measureHeldRules } from './doctrine.js';
import { stageTestRegistries } from './registries.js';
import { fileSystemAdapter } from '../../../fs/index.js';
const fs = fileSystemAdapter();

/** Printed instead of a patch when this checkout is not the tree the coordinator named, so the coordinator derives locally. */
export const DERIVE_UNAVAILABLE = 'LANDING_DERIVE_UNAVAILABLE';

/** The prefixes of the lines a derive job prints: the staged patch (base64), the tree it yields, and the engines it numbered. */
export const DERIVE_PATCH = 'LANDING_DERIVE_PATCH=';
export const DERIVE_TREE = 'LANDING_DERIVE_TREE=';
export const DERIVE_ENGINES = 'LANDING_DERIVE_ENGINES=';
/** The doctrine rows a derive job counted on the derived tree, as JSON; absent when the job was not asked or a rule needs a browser [C7,#5583]. */
export const DERIVE_RULES = 'LANDING_DERIVE_RULES=';

/** The tighten script beside the closure ceilings file (named by the gate cell, not spelled here), and how long its run may take before it is abandoned [C7,#12053]. */
const TIGHTEN_SCRIPT = join(dirname(CLOSURE_CEILINGS), 'tighten.js');
const TIGHTEN_TIMEOUT_MS = 120000;

/** Run the tighten script in `root`; resolves whether it exited 0 within the time cap. Async so a leased caller's timer keeps firing. */
function runTighten(root) {
  return new Promise(resolve => {
    execFile(process.execPath, [TIGHTEN_SCRIPT, '--write'], { cwd: root, timeout: TIGHTEN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, error => resolve(!error));
  });
}

/**
 * Re-baseline the closure ceilings downward by running the tighten script in the merged tree; resolves the ceilings file when it changed, else nothing.
 * Why: main owns the ceilings, so each landing tightens them to what main measures; a failed or timed-out run stages nothing and never fails the landing.
 */
async function tightenClosureCeilings(root) {
  if (!fs.exists(join(root, TIGHTEN_SCRIPT))) return [];
  if (!await runTighten(root)) { git(root, ['checkout', 'HEAD', '--', CLOSURE_CEILINGS]); return []; }
  return git(root, ['diff', '--name-only', 'HEAD', '--', CLOSURE_CEILINGS]).split('\n').filter(Boolean);
}

/**
 * Derive and stage everything a landing writes after an item merge: engine numbers and their history, the format table, generated docs.
 * Why: one function builds the files whether the coordinator or a runner runs it, so the two can never differ.
 * @param {string} root A checkout of the merged tree.
 * @returns {{ engines: { files: string[], assigned: { name: string, number: number }[] } }} What was staged.
 */
export async function stageLandingDerived(root) {
  const engines = assignEngineNumbers(root);
  if (fs.exists(join(root, 'packages/state/src/io/formats')) && fs.exists(join(root, 'docs', 'formats.md'))
    && writeFormatTable(root) && !engines.files.includes('docs/formats.md')) engines.files.push('docs/formats.md');
  refreshLandingDocs(root);
  const generatedChanges = git(root, ['diff', '--name-only', 'HEAD', '--', ...GENERATED_DOC_PATHS]).split('\n').filter(Boolean);
  for (const file of generatedChanges) if (!engines.files.includes(file)) engines.files.push(file);
  for (const file of await tightenClosureCeilings(root)) if (!engines.files.includes(file)) engines.files.push(file);
  if (engines.files.length) git(root, ['add', '--', ...engines.files]);
  return { engines };
}

/** Allocate and stage engine history, then place it before amending that same item merge; hooks are extra Git flags. */
export async function amendLandingEngines(root, hooks = []) {
  const { engines } = await stageLandingDerived(root);
  if (engines.files.length) git(root, [...hooks, 'commit', '--amend', '--no-edit']);
  return engines;
}

/**
 * Refresh the test registries and badge documents on a merged tree and amend them into its last merge, as a batch's derive did; resolves the paths staged.
 * Why: a pulled land job runs no batch, so main kept hand-edited registries and stale badges until it called this after amendLandingEngines (#7027) [C7].
 * @param {string} root A checkout of the merged tree.
 * @param {{ base?: string, badges?: { path: string, text: string }[], hooks?: string[] }} [options] - base: the commit the merges started from.
 */
export async function amendLandingRegistries(root, { base = 'HEAD^1', badges = [], hooks = [] } = {}) {
  const staged = [...await stageTestRegistries(root, base), ...stageBadgeDocuments(root, badges)];
  if (git(root, ['diff', '--cached', '--name-only']).trim()) git(root, [...hooks, 'commit', '--amend', '--no-edit']);
  return staged;
}

/** Run a git command in `cwd`, feeding `input` on stdin; resolves its status and stdout bytes. Async so a leased caller's timer keeps firing. */
export function gitStdin(cwd, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = gitSpawn(args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout: Buffer.concat(out) }));
    child.stdin.end(input);
  });
}

/** The value after `flag` on the command line, or undefined. */
function argument(flag) {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/**
 * Write the badge documents the coordinator computed (path and text pairs) and stage the ones that changed.
 * Why: the coordinator holds the board, a runner does not, so it passes the finished documents rather than the counts [C7,#5583].
 * @returns {string[]} The paths that changed.
 */
export function stageBadgeDocuments(root, documents) {
  const changed = [];
  for (const document of documents) {
    const file = join(root, document.path);
    if (fs.exists(file) && fs.readFile(file, 'utf8') === document.text) continue;
    fs.mkdir(dirname(file), { recursive: true });
    fs.writeFile(file, document.text);
    changed.push(document.path);
  }
  if (changed.length) git(root, ['add', '--', ...changed]);
  return changed;
}

/** Run as a runner job: derive in the checkout and print the staged patch, so the coordinator only applies it. No top-level await. */
async function main() {
  const root = process.cwd();
  const wanted = argument('--tree');
  if (git(root, ['rev-parse', 'HEAD^{tree}']) !== wanted) { process.stdout.write(`${DERIVE_UNAVAILABLE}\n`); return; }
  const { engines } = await stageLandingDerived(root);
  await stageTestRegistries(root, argument('--base') ?? 'HEAD^1');
  const badges = argument('--badges');
  if (badges) stageBadgeDocuments(root, JSON.parse(Buffer.from(badges, 'base64').toString('utf8')));
  const patch = await gitStdin(root, ['diff', '--cached', '--binary', 'HEAD']);
  if (patch.status !== 0) throw new Error('git diff failed');
  process.stdout.write(`${DERIVE_ENGINES}${engines.assigned.map(entry => `${entry.name}:${entry.number}`).join(',')}\n`);
  process.stdout.write(`${DERIVE_TREE}${git(root, ['write-tree'])}\n`);
  process.stdout.write(`${DERIVE_PATCH}${patch.stdout.toString('base64')}\n`);
  if (process.argv.includes('--doctrine')) {
    // Counted on the committed derived tree, exactly what the coordinator will hold after it applies the patch above.
    if (patch.stdout.length) git(root, ['-c', 'user.name=derive', '-c', 'user.email=derive@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'derive']);
    const rows = await measureHeldRules(root, { practice: argument('--practice') });
    if (rows) process.stdout.write(`${DERIVE_RULES}${JSON.stringify(rows)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
