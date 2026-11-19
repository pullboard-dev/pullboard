/** The land job's contracts: affected tests main gained since the items' bases that no landed item's submit proved [C7,#7821]. */
import { selectAffectedTests } from '../../../../gate/heavy.js';
import { tryGit } from '../../../../git/index.js';
import { ledgerProofCheck } from './proof.js';
import { admitTrunk } from './job.js';
import { must } from './job.js';

// The selection's reason when a change reaches every test file: it names them all, so they are selected, not unknown.
const REACHES_EVERY = 'the change reaches every test file';

/**
 * The files main changed after any merged item's own base (its merge-base with the trunk tip): what the merge onto
 * current main brings that the item's gate never saw. Null when an item commit is unknown to the checkout, so the
 * caller cannot narrow the selection and keeps none of it.
 */
function mainGained(root, base, commits) {
  const gained = new Set();
  for (const commit of commits) {
    const fork = tryGit(root, ['merge-base', commit, base]);
    if (fork.status !== 0) return null;
    const diff = tryGit(root, ['diff', '--no-renames', '--name-only', '-z', fork.stdout.trim(), base]);
    if (diff.status !== 0) return null;
    for (const file of diff.stdout.split('\0')) if (file) gained.add(file);
  }
  return gained;
}

/**
 * The contract test files a landing owes: the affected tests of the merged change that main gained or changed after
 * the merged items' bases, less the files the items' submits already proved (the ledger proof's and the deferred
 * files). Empty when the selection falls back to the full suite: an unselectable change keeps its items' own proofs,
 * since one runner cannot finish every test in a landing [C7].
 * Why main's files only: every other affected test either is in an item's gate set, which the ledger proof reruns
 * when main moved its import closure, or was left out by that gate on purpose; reselecting the item's whole change
 * reran 2,067 files serially for #7767, whose gate proved 151 (#7821).
 *
 * @param {string} root - The merged landing checkout.
 * @param {string} base - The trunk tip the items merged onto.
 * @param {{ proved: Set<string>, derived: Set<string>, commits?: string[] }} known - proved: files the submits ran; derived: files the landing itself writes; commits: the merged items' commits.
 * @returns {{ files: string[], full: string | null }} full: why the selection fell back to every test, when it did.
 */
export function contractFiles(root, base, { proved, derived, commits = [] }) {
  const gained = mainGained(root, base, commits);
  // Main moved no file since the items' bases: their gates saw this tree's every contract [#7821].
  if (!gained?.size) return { files: [], full: null };
  const diff = tryGit(root, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']);
  if (diff.status !== 0) throw new Error(`git diff of the merged tree failed: ${diff.stderr.slice(0, 300)}`);
  // The badge documents a landing writes select nothing; counted as changes they sent the selection to the full suite [C7].
  const changed = diff.stdout.split('\0').filter(file => file && !derived.has(file));
  if (!changed.length) return { files: [], full: null };
  const selected = selectAffectedTests(root, { base, commit: 'HEAD', changed });
  // A change that reaches every test file still names them; only an unselectable change falls back [C7].
  if (selected.full && selected.reason !== REACHES_EVERY) return { files: [], full: selected.reason };
  return { files: selected.files.filter(file => gained.has(file) && !proved.has(file)), full: null };
}

/**
 * The contracts account's reused and run files, apart: the files the ledger's hit list covered at unchanged inputs, and
 * the rest, which ran (landing.reuseContractResults). Counts come from the run, so a capped file list never skews them.
 *
 * @param {string[]} files - Every contract file of the landing.
 * @param {{ reused?: number, reusedFiles?: string[] } | undefined} proof - The proof run's account.
 * @returns {{ reused: { files: string[], count: number }, run: { files: string[], count: number } }}
 */
export function contractAccount(files, proof) {
  const reusedFiles = Array.isArray(proof?.reusedFiles) ? proof.reusedFiles : [];
  const hit = new Set(reusedFiles);
  const ran = files.filter(file => !hit.has(file));
  const reused = Number.isSafeInteger(proof?.reused) ? proof.reused : reusedFiles.length;
  return { reused: { files: reusedFiles.slice(0, 20), count: reused }, run: { files: ran.slice(0, 20), count: Math.max(0, files.length - reused) } };
}

/**
 * The land job's contract check: run, on the tree it is checking, the affected tests that reached main after the items
 * were submitted, or that their submits deferred to the batch (T3 journeys), with the project's runner. Why: a pulled
 * land job proved only each item's own files, so an item landed red against a test main gained after its submit; the
 * controller's batch gate ran them, and it is being deleted (#6807, #7378) [C7].
 *
 * @param {{ contracts?: { runner?: string }, items?: { id: number, commit: string }[], proof?: { files?: string[] } | null, deferred?: { files?: Record<string, string[]> } | null, badges?: { path: string }[], waivers?: object[] }} payload
 * @param {NodeJS.ProcessEnv} env
 * @returns {((context: { root: string, base: string, items?: number[] }) => Promise<{ ok: boolean, detail: string | null, contracts: { files: string[], count: number, full?: string, mainRed?: { file: string, name: string }[] } }>) | null} null when the job names no runner;
 *   mainRed: a red the base fails identically, or in a file the ledger records red on main at the base, recorded as a known main red while the item lands;
 *   ledgerMainRed: the files the ledger excused [C7,U152].
 */
export function contractCheck(payload, env) {
  const runner = typeof payload.contracts?.runner === 'string' && payload.contracts.runner.trim() && !/[\0\n\r]/u.test(payload.contracts.runner) ? payload.contracts.runner.trim() : null;
  if (!runner) return null;
  const proved = new Set([...(payload.proof?.files ?? []), ...Object.values(payload.deferred?.files ?? {}).flat()]);
  const derived = new Set((payload.badges ?? []).map(entry => entry?.path).filter(path => typeof path === 'string'));
  const waivers = Array.isArray(payload.waivers) ? payload.waivers : [];
  // landing.ledgerMainReds: the board's red-now files ride on the job; absent, every red is compared on the base as before [C7,U152].
  const mainReds = Array.isArray(payload.mainReds) ? payload.mainReds : null;
  // An enclosing node --test run's context never reaches the contracts, which would then report to it, not as their own run.
  const { NODE_TEST_CONTEXT, ...own } = env;
  return async context => {
    // The items in the tree being checked: a culprit search checks a prefix of them [P7].
    const merged = new Set(context.items ?? (payload.items ?? []).map(entry => entry.id));
    const commits = (payload.items ?? []).filter(entry => merged.has(entry.id)).map(entry => entry.commit);
    const { files, full } = contractFiles(context.root, context.base, { proved, derived, commits });
    // The receipt names what ran, so a landing that ran no contract says why [C7].
    const contracts = { files: files.slice(0, 20), count: files.length, ...(full ? { full } : {}) };
    if (!files.length) return { ok: true, detail: null, contracts };
    // No ledger hits unless landing.reuseContractResults rides on the job: a file the merged change reaches has a new inputKey, so a hit list could reuse none of them.
    const reuse = payload.contracts.reuse === true;
    const result = await ledgerProofCheck({ runner, files, ledger: reuse ? payload.contracts.ledger ?? null : null }, { env: own, waivers, reuseGate: reuse })(context);
    // With the setting on, the account names the reused files and the run files apart [C7,#9301].
    if (reuse) Object.assign(contracts, contractAccount(files, result.proof));
    const known = result.ok ? null : await mainOwnedReds(context, result.failures, { mainReds,
      rerun: failures => baseReds(context, { runner, trunk: payload.trunk, failures, env: own }) });
    if (known) return { ok: true, detail: null, contracts: { ...contracts, mainRed: known.known, ...(known.ledger.length ? { ledgerMainRed: known.ledger } : {}) } };
    return { ok: result.ok, detail: result.ok ? null : result.detail?.replace(/^landing proof/u, 'landing contracts'), contracts, ...(result.waived ? { waived: result.waived } : {}), ...(result.failed ? { failed: result.failed } : {}) };
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

/**
 * The files of `mainReds` the ledger records red on main at the base: the red row's commit is the base or one of its
 * ancestors, and the base holds the file. A commit the checkout does not know, or one off main, excuses nothing.
 *
 * @param {string} root - The landing checkout.
 * @param {string} base - The trunk tip the items merged onto.
 * @param {unknown[]} mainReds - The job's `[file, commit]` pairs (landingMainReds).
 * @returns {Set<string>}
 */
export function ledgerMainRedFiles(root, base, mainReds) {
  const onMain = new Map();
  const reaches = commit => {
    if (!onMain.has(commit)) onMain.set(commit, commit === base || tryGit(root, ['merge-base', '--is-ancestor', commit, base]).status === 0);
    return onMain.get(commit);
  };
  const files = new Set();
  for (const pair of mainReds) {
    const [file, commit] = Array.isArray(pair) ? pair : [];
    if (typeof file !== 'string' || !file || typeof commit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) continue;
    if (reaches(commit) && tryGit(root, ['cat-file', '-e', `${base}:${file}`]).status === 0) files.add(file);
  }
  return files;
}

/**
 * The contract red as main's own, or null when any failure is the merge's. With `mainReds` (landing.ledgerMainReds on),
 * a failure in a file the ledger records red on main at the base is main's without a rerun, and only the rest are rerun
 * on the base; without it, every failure is rerun on the base as before. Why: a rerun matched case for case held
 * #8249 three times on reds main already had (#8477); a red in a file main passes still holds the landing [C7,U152].
 *
 * @param {{ root: string, base: string }} context
 * @param {{ file: string, name: string }[] | null | undefined} failures - The red's failing tests, each with its file.
 * @param {{ mainReds?: unknown[] | null, rerun: (failures: { file: string, name: string }[]) => Promise<{ file: string, name: string }[] | null> }} ports
 * @returns {Promise<{ known: { file: string, name: string }[], ledger: string[] } | null>} ledger: the files the ledger excused.
 */
export async function mainOwnedReds(context, failures, { mainReds = null, rerun }) {
  if (!failures?.length) return null;
  if (!mainReds) { const known = await rerun(failures); return known ? { known, ledger: [] } : null; }
  const recorded = ledgerMainRedFiles(context.root, context.base, mainReds);
  const ledger = failures.filter(row => recorded.has(row.file));
  const rest = failures.filter(row => !recorded.has(row.file));
  const shared = rest.length ? await rerun(rest) : [];
  if (!shared) return null;
  return { known: [...ledger, ...shared].map(row => ({ file: row.file, name: row.name })), ledger: [...new Set(ledger.map(row => row.file))].sort() };
}
