/** The land job's contracts: affected tests on the merged tree that no landed item's submit proved [C7]. */
import { selectAffectedTests } from '../../../../gate/index.js';
import { tryGit } from '../../../../git/index.js';
import { ledgerProofCheck } from './proof.js';
import { admitTrunk } from './job.js';
import { must } from './job.js';

// The selection's reason when a change reaches every test file: it names them all, so they are selected, not unknown.
const REACHES_EVERY = 'the change reaches every test file';

/**
 * The test files the gate's selection reaches from the merged change, less the files the items' submits already
 * proved (the ledger proof's and the deferred files). Empty when the selection falls back to the full suite: an
 * unselectable change keeps its items' own proofs, since one runner cannot finish every test in a landing [C7].
 *
 * @param {string} root - The merged landing checkout.
 * @param {string} base - The trunk tip the items merged onto.
 * @param {{ proved: Set<string>, derived: Set<string> }} known - proved: files the submits ran; derived: files the landing itself writes.
 * @returns {{ files: string[], full: string | null }} full: why the selection fell back to every test, when it did.
 */
export function contractFiles(root, base, { proved, derived }) {
  const diff = tryGit(root, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']);
  if (diff.status !== 0) throw new Error(`git diff of the merged tree failed: ${diff.stderr.slice(0, 300)}`);
  // The badge documents a landing writes select nothing; counted as changes they sent the selection to the full suite [C7].
  const changed = diff.stdout.split('\0').filter(file => file && !derived.has(file));
  if (!changed.length) return { files: [], full: null };
  const selected = selectAffectedTests(root, { base, commit: 'HEAD', changed });
  // A change that reaches every test file still names them; only an unselectable change falls back [C7].
  if (selected.full && selected.reason !== REACHES_EVERY) return { files: [], full: selected.reason };
  return { files: selected.files.filter(file => !proved.has(file)), full: null };
}

/**
 * The land job's contract check: run, on the tree it is checking, the affected tests that reached main after the items
 * were submitted, or that their submits deferred to the batch (T3 journeys), with the project's runner. Why: a pulled
 * land job proved only each item's own files, so an item landed red against a test main gained after its submit; the
 * controller's batch gate ran them, and it is being deleted (#6807, #7378) [C7].
 *
 * @param {{ contracts?: { runner?: string }, proof?: { files?: string[] } | null, deferred?: { files?: Record<string, string[]> } | null, badges?: { path: string }[], waivers?: object[] }} payload
 * @param {NodeJS.ProcessEnv} env
 * @returns {((context: { root: string, base: string }) => Promise<{ ok: boolean, detail: string | null, contracts: { files: string[], count: number, full?: string, mainRed?: { file: string, name: string }[] } }>) | null} null when the job names no runner;
 *   mainRed: a red the base fails identically, recorded as a known main red while the item lands.
 */
export function contractCheck(payload, env) {
  const runner = typeof payload.contracts?.runner === 'string' && payload.contracts.runner.trim() && !/[\0\n\r]/u.test(payload.contracts.runner) ? payload.contracts.runner.trim() : null;
  if (!runner) return null;
  const proved = new Set([...(payload.proof?.files ?? []), ...Object.values(payload.deferred?.files ?? {}).flat()]);
  const derived = new Set((payload.badges ?? []).map(entry => entry?.path).filter(path => typeof path === 'string'));
  const waivers = Array.isArray(payload.waivers) ? payload.waivers : [];
  // An enclosing node --test run's context never reaches the contracts, which would then report to it, not as their own run.
  const { NODE_TEST_CONTEXT, ...own } = env;
  return async context => {
    const { files, full } = contractFiles(context.root, context.base, { proved, derived });
    // The receipt names what ran, so a landing that ran no contract says why [C7].
    const contracts = { files: files.slice(0, 20), count: files.length, ...(full ? { full } : {}) };
    if (!files.length) return { ok: true, detail: null, contracts };
    // No ledger hits: a file the merged change reaches has a new inputKey, so a hit list could reuse none of them.
    const result = await ledgerProofCheck({ runner, files, ledger: null }, { env: own, waivers })(context);
    const known = result.ok ? null : await baseReds(context, { runner, trunk: payload.trunk, failures: result.failures, env: own });
    if (known) return { ok: true, detail: null, contracts: { ...contracts, mainRed: known } };
    return { ok: result.ok, detail: result.ok ? null : result.detail?.replace(/^landing proof/u, 'landing contracts'), contracts, ...(result.waived ? { waived: result.waived } : {}) };
  };
}

/**
 * The contract red as main's own: rerun the red's failing files on the base the items merged onto, and return those
 * failures when every one of them fails there too, by file and test name; else null. Why: a contract main already
 * fails would hold every pulled landing, while a failure the base passes, a new failing case, a file only the merge
 * adds, or a red whose TAP names no file is the merge's own and keeps the item out [C7,#7458].
 *
 * @param {{ root: string, base: string }} context - The landing checkout, at the merged tree being checked.
 * @param {{ runner: string, trunk?: string, failures?: { file: string, name: string }[] | null, env: NodeJS.ProcessEnv }} red
 * @returns {Promise<{ file: string, name: string }[] | null>} The failures main shares, which the receipt records as known main reds.
 */
async function baseReds({ root, base }, { runner, trunk = 'refs/heads/main', failures, env }) {
  if (!failures?.length) return null;
  const files = [...new Set(failures.map(row => row.file))];
  if (files.some(file => tryGit(root, ['cat-file', '-e', `${base}:${file}`]).status !== 0)) return null;
  const head = must(root, ['rev-parse', 'HEAD']);
  const visit = commit => { must(root, ['checkout', '-q', '--detach', '--force', commit]); must(root, ['clean', '-q', '-fd']); admitTrunk(root, { trunk, base }); };
  let onBase = null;
  // A base that cannot be checked out or run proves nothing about main, so the red stays the merge's own.
  try {
    visit(base);
    onBase = await ledgerProofCheck({ runner, files, ledger: null }, { env })({ root });
  } catch { onBase = null; } finally { visit(head); }
  if (!onBase || onBase.ok || !onBase.failures) return null;
  const shared = new Set(onBase.failures.map(row => `${row.file}\0${row.name}`));
  return failures.every(row => shared.has(`${row.file}\0${row.name}`)) ? failures.map(row => ({ file: row.file, name: row.name })) : null;
}
