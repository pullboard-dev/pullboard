/** Select testing tiers from immutable source; caller hints never hide a changed package [C7,CS4,V4]. */
import { gitSpawnSync } from '../../../../../git/index.js';
import { currentGitAdapter } from '../../../../../git/index.js';
import { realGitAdapter } from '../../../../../git/index.js';
import { posix } from 'node:path';
import { cleanGitEnvironment } from '../../../../../git/index.js';
import { checkCommandDefinition } from '../../../../../git/index.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testOutcomeFields } from '../outcomes.js';
import { Refused } from '../../../../../kernel/index.js';
import { literalShellWords } from '../../../../../kernel/index.js';
import { generateTestTiersFrom } from '../tiers.js';
import { pushOnlyTests } from '../push-only.js';
import { commitSourceSnapshot } from '../../snapshot.js';
import { ownerOf } from '../tiers.js';
import { TEST_TIERS_FILE } from '../tiers.js';
import { unsealedPackages } from '../../seals.js';
import { sealOf } from '../../seals.js';
import { sealStoreFile } from '../../seals.js';
import { sealsExist } from '../../seals.js';
import { checkSkippedSeals } from '../../seals.js';
import { refusalFloor } from '../../refusal/floor.js';
import { codeMapGraph } from '../../affected/tests.js';
import { BASELINE_TABLES } from '../../../../../commits/light.js';
import { readTierSnapshot } from './cache.js';
import { writeTierSnapshot } from './cache.js';
import { CELLS_EDGES_CEILINGS } from '../../edges.js';

const snapshots = new Map();
const TEST_HELPER = /(?:^|\/)(?:test|tests)\//u;

/** Read exact Git objects or construct an isolated read view without executing project hooks. */
function sourceGit(root, args, optional = false, { input, binary = false } = {}) {
  const result = gitSpawnSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { ...cleanGitEnvironment(), GIT_OPTIONAL_LOCKS: '0' }, ...(binary ? {} : { encoding: 'utf8' }), ...(input === undefined ? {} : { input }), maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout;
  if (optional) return null;
  throw new Refused('TEST_SELECTION_SOURCE', 'the immutable test-selection source could not be read; restore Git history and retry');
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** Answers about exact object ids, which never change: a resolved commit, and whether its tree holds the manifest. */
const exactAnswers = new Map();

/**
 * Remember one answer about an exact object id under real Git, or compute it every time under an injected adapter.
 * Why: one submit asked Git the same commit and manifest question up to eight times, a process each (#5900).
 */
function exactAnswer(key, read) {
  if (currentGitAdapter() !== realGitAdapter) return read();
  if (exactAnswers.has(key)) return exactAnswers.get(key);
  const value = read();
  exactAnswers.set(key, value);
  if (exactAnswers.size > 256) exactAnswers.delete(exactAnswers.keys().next().value);
  return value;
}

/** Resolve one immutable commit instead of retaining a movable ref inside the selection. */
function commitAt(root, ref) {
  const resolve = () => {
    const commit = sourceGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    if (!OBJECT_ID.test(commit)) throw new Refused('TEST_SELECTION_SOURCE', 'test selection needs a real committed source');
    return commit;
  };
  // A movable ref is read every time; an exact id that resolved once resolves the same way for good.
  return OBJECT_ID.test(ref) ? exactAnswer(JSON.stringify(['commit', root, ref]), resolve) : resolve();
}

/** The checked-in portable manifest enables tiers for any project; older projects keep their existing gate. */
export function hasTestTiers(root, commit = 'HEAD') {
  const read = () => sourceGit(root, ['cat-file', '-e', `${commit}:${TEST_TIERS_FILE}`], true) !== null;
  // A commit's tree never changes, so the answer for an exact commit already resolved here is final; a missing object is
  // asked again, since a fetch can bring it.
  return OBJECT_ID.test(commit) && exactAnswers.get(JSON.stringify(['commit', root, commit])) === commit
    ? exactAnswer(JSON.stringify(['tiers', root, commit]), read) : read();
}

/**
 * The testing tiers recomputed from a commit's Git objects alone, equal to generating them in a checkout of it.
 * Why: a clone and checkout per commit cost a coordinator machine a full working tree for each of 317 review comparisons a
 * day; the sealed in-memory source is read with one ls-tree and one cat-file --batch [C7,V4].
 *
 * @param {string} root any checkout of the repository
 * @param {string} commit the exact commit id
 * @param {{ onInventory?: Function, onReach?: Function }} [hooks] the same observers generateTestTiers takes
 * @returns {{ version: number, files: object[] }}
 */
export function generateTestTiersAt(root, commit, hooks) {
  const snapshot = commitSourceSnapshot(commit, {
    tree: sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit]),
    blobs: shas => sourceGit(root, ['cat-file', '--batch'], false, { input: shas.map(sha => `${sha}\n`).join(''), binary: true }),
  });
  if (!snapshot) throw new Refused('TEST_SELECTION_SOURCE', 'a committed blob is unavailable; restore Git history and retry');
  return generateTestTiersFrom(snapshot, hooks);
}

/** The modules whose code, with everything they import, decides a commit's tiers. */
const TIER_CODE = ['../tiers.js', './selection.js', '../../snapshot.js'].map(path => fileURLToPath(new URL(path, import.meta.url)));
let tierCode;

/** The digest of the tier code's bytes by path inside this tool and of the Node version, or null when unreadable (#3927). */
function tierCodeDigest() {
  if (tierCode !== undefined) return tierCode;
  try {
    const files = checkCommandDefinition(fileURLToPath(new URL('../../../../../../', import.meta.url)), [], TIER_CODE).map(file => [file.path, file.mode, file.digest]);
    tierCode = createHash('sha256').update(JSON.stringify({ node: process.version, files })).digest('hex');
  } catch { tierCode = null; }
  return tierCode;
}

/** Recompute classifications and ownership from the exact source, including stale or edited manifest rows. */
function snapshotAt(root, commit, componentTier = false) {
  const common = sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const key = `${common}:${commit}${componentTier ? ':component' : ''}`;
  if (snapshots.has(key)) return snapshots.get(key);
  // Another process on this machine may have built this commit's tiers with the same code (#3927).
  // A component-tier snapshot carries T2 rows, so it has its own cache entry beside the default one (#9788).
  const code = tierCodeDigest() && componentTier ? createHash('sha256').update(`${tierCodeDigest()}:componentTier`).digest('hex') : tierCodeDigest();
  const cached = readTierSnapshot(commit, code);
  if (cached) {
    const result = { ...cached, rows: new Map(cached.manifest.files.map(row => [row.file, row])) };
    snapshots.set(key, result);
    if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
    return result;
  }
  // Read from the commit's Git objects: a sealed in-memory source, no clone or checkout on this machine [C7,V4].
  let owners, packageFiles;
  const helpers = new Map();
  const manifest = generateTestTiersAt(root, commit, {
    componentTier,
    onInventory: inventory => {
      owners = inventory.owners;
      packageFiles = new Set([...inventory.files.keys()].filter(file => file === 'package.json' || file.endsWith('/package.json')));
    },
    onReach: row => {
      if (row.tier !== 'T1') return;
      for (const path of row.reached) if (TEST_HELPER.test(path)) {
        const packages = helpers.get(path) ?? new Set();
        for (const name of row.packages) packages.add(name);
        helpers.set(path, packages);
      }
    },
  });
  const result = { manifest, owners, packageFiles, helpers, rows: new Map(manifest.files.map(row => [row.file, row])) };
  writeTierSnapshot(commit, code, result);
  snapshots.set(key, result);
  if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
  return result;
}

/**
 * A package's own test that only crosses into what it imports counts as its unit, so an unsealed importer runs it.
 * The repository root ('.') owns no units this way: its cross-package files are journeys. Selection and the
 * completeness guard share this one rule, so the guard never demands a file the selection is right to leave out.
 */
function ownUnit(row, snapshot, unsealed) {
  const owner = ownerOf(row.file, snapshot.packageFiles, snapshot.owners);
  return Boolean(owner) && owner !== '.' && unsealed.has(owner) && row.reasons.every(reason => reason.startsWith('cross-package:'));
}

/** The canary a project with no `canary` list in pullboard.json runs at every gate: the closure budget and stable-ID files [C7,#10874]. */
export const DEFAULT_CANARY = Object.freeze(['apps/cli/journeys/imports/closure-budget.test.js', 'apps/cli/tests/stable.test.js']);

/**
 * The canary test files of one commit: its pullboard.json `canary` list, else DEFAULT_CANARY, keeping only files its tree
 * holds, so a project without them runs none and a stale entry is skipped, never refused. `canary: []` turns it off.
 * Why: a change confined to one cell selects no journey, yet one eager import there can push every command over its
 * closure budget; #10800 landed that way through the board's own gate, and only the hand lander's canary caught it [C7,#10874].
 *
 * @param {string} root any checkout of the repository
 * @param {string} [commit] the commit whose config and tree decide the canary
 * @returns {string[]} the sorted repo-relative test files
 */
export function canaryTests(root, commit = 'HEAD') {
  let declared;
  try { declared = JSON.parse(sourceGit(root, ['show', `${commit}:pullboard.json`], true) ?? '{}')?.canary; } catch { /* An unreadable config declares nothing; the default stands. */ }
  const listed = Array.isArray(declared)
    ? declared.filter(file => typeof file === 'string' && file && !file.startsWith('-') && !file.startsWith('/')).map(file => posix.normalize(file))
    : DEFAULT_CANARY;
  if (!listed.length) return [];
  const present = sourceGit(root, ['ls-tree', '-r', '-z', '--name-only', commit, '--', ...listed], true);
  const wanted = new Set(listed);
  return present === null ? [] : [...new Set(present.split('\0').filter(file => wanted.has(file)))].sort();
}

/**
 * Select only units belonging to changed packages and defer every current journey to the batch.
 * `auditOnly` is landing.auditOnly, joined by the push-only listing (packages/gate/data/tests/push-only.json): a listed file the change does not itself touch is left to the main audit and named in `auditLeft`,
 * so a repo-wide inventory test never turns one item's gate red [C7].
 * `componentTier` is gate.componentTier, read by the caller (default off): a T2 test, which reaches other cells only through
 * their front doors, is then selected only when a changed file is one of its doors, never for a change inside a cell [C7,#9788].
 */
export function selectTestTiers(root, { base, trunk, commit = 'HEAD', changed, runner = 'node --test', auditOnly = [], componentTier = false } = {}) {
  commit = commitAt(root, commit);
  if (trunk) {
    const mergeBase = sourceGit(root, ['merge-base', trunk, commit]).trim();
    if (mergeBase !== commit) base = mergeBase;
  }
  base = base ? commitAt(root, base) : null;
  const enabled = hasTestTiers(root, commit);
  if (!enabled && (!base || !hasTestTiers(root, base))) return null;
  if (!enabled) throw new Refused('TEST_TIER_MANIFEST', 'restore the generated tier manifest before submitting or reviewing this change');
  let declared;
  try { declared = JSON.parse(sourceGit(root, ['show', `${commit}:${TEST_TIERS_FILE}`])); } catch { /* Refuse below. */ }
  if (declared?.version !== 1 || !Array.isArray(declared.files)) throw new Refused('TEST_TIER_MANIFEST', 'regenerate and commit the testing tier manifest');
  const actual = base ? sourceGit(root, ['diff', '--no-renames', '--name-only', '-z', base, commit]).split('\0').filter(Boolean).sort() : null;
  if (changed !== undefined) {
    const supplied = [...new Set(changed.map(file => posix.normalize(file)))].sort();
    if (!actual || JSON.stringify(supplied) !== JSON.stringify(actual)) {
      const hidden = actual?.filter(file => !supplied.includes(file)) ?? [];
      throw new Refused('TEST_SELECTION_INCOMPLETE', `the supplied change list differs from Git${hidden.length ? `; hidden changes: ${hidden.join(', ')}` : ''}; derive selection from the committed diff`);
    }
  }
  const after = snapshotAt(root, commit, componentTier === true), before = base ? snapshotAt(root, base, componentTier === true) : after;
  const packages = new Set();
  // Cells the test-cell check records as sealed (packages/gate/data/tests/test-cells.json): their tests conform, so the plan names them [C7].
  const sealedCells = sealedTestCells(root, commit);
  const hardGlobal = isHardGlobal(actual);
  const confined = confinementOf(root, base, commit, actual, sealedCells);
  const global = hardGlobal;
  if (global) for (const row of after.manifest.files) for (const name of row.packages) packages.add(name);
  else for (const file of actual) {
    for (const snapshot of [before, after]) {
      const associated = snapshot.rows.get(file)?.packages ?? (snapshot.helpers.has(file) ? [...snapshot.helpers.get(file)] : null);
      if (associated) for (const name of associated) packages.add(name);
      else {
        const owner = ownerOf(file, snapshot.packageFiles, snapshot.owners);
        if (owner) packages.add(owner);
      }
    }
  }
  // RFC 0006 A3: a change also runs every package its hashes unseal, so importers of a changed front door run too.
  const seals = base ? unsealedPackages(root, { base, head: commit }) : null;
  for (const row of seals?.unsealed ?? []) if (row.hash) packages.add(row.package);
  const skipped = !global && seals ? sealedSkips(root, seals, after.manifest, packages) : [];
  const doors = new Set([...(seals?.doors ?? []), ...(actual ?? []).filter(file => /^(?:packages|apps)\/[^/]+\/index\.js$/u.test(file))]);
  const contractRoots = [...doors].map(door => ownerOf(door, after.packageFiles, after.owners)).filter(Boolean).map(name => `${name}/contract/`);
  const contracts = after.manifest.files.map(row => row.file).filter(file => contractRoots.some(prefix => file.startsWith(prefix)));
  // A package's own tests that only cross into what it imports are its units too, so an unsealed importer runs them.
  const unsealedNames = new Set((seals?.unsealed ?? []).filter(row => row.hash).map(row => row.package));
  const own = row => ownUnit(row, after, unsealedNames);
  // A test file the change itself adds or edits runs at submit whatever its tier, so a builder's own new test is
  // proved in minutes rather than first at review or landing (4 Nov: 2 of 2 audited rejects were such tests).
  const authored = new Set((actual ?? []).filter(file => after.rows.has(file)));
  // A floor invariant runs at submit when the change reaches its inputs: refusal codes reach the declaration audit through
  // source text, never through imports, so a diff that adds or edits one names that audit here (#3184).
  for (const file of refusalFloor({ changed: actual, manifest: after.manifest,
    read: (path, side) => sourceGit(root, ['show', `${side === 'base' ? base : commit}:${path}`], true) })) authored.add(file);
  const changedFiles = new Set(actual ?? []);
  const doorChanged = row => global || row.doors?.some(door => changedFiles.has(door));
  const selects = row => row.tier === 'T2' ? doorChanged(row) : confined ? confinedUnit(row, confined.roots, doors) : (row.tier === 'T1' && row.packages.some(name => packages.has(name))) || own(row);
  const units = [...new Set([...after.manifest.files.filter(row => selects(row) || authored.has(row.file)).map(row => row.file), ...contracts])].sort();
  // A confined change runs no journey: nothing outside a sealed cell reaches past its front door (#4003). The one exception
  // is a test that reads a listing file the change carried: that file is its input, so it stays selected (#4633).
  const readers = confined?.listings.length ? listingReaders(root, base, commit, confined.listings) : null;
  const journeys = confined ? after.manifest.files.filter(row => readers?.has(row.file) && !units.includes(row.file)).map(row => row.file)
    : after.manifest.files.filter(row => row.tier === 'T3' && !units.includes(row.file)).map(row => row.file);
  // The push-only listing joins landing.auditOnly here, the one place every item gate selects its files [R4,C7].
  const audit = new Set([...(Array.isArray(auditOnly) ? auditOnly : []), ...pushOnlyTests()].filter(file => typeof file === 'string'));
  const touched = new Set(actual ?? []);
  // The canary runs at every gate whatever the change reaches, and no audit listing leaves it out [C7,#10874].
  const canary = canaryTests(root, commit);
  const left = [...new Set([...units, ...journeys])].filter(file => audit.has(file) && !touched.has(file) && !canary.includes(file)).sort();
  const kept = file => !left.includes(file);
  return { version: 1, commit, base, packages: [...packages].sort(), changed: actual ?? [], units: [...new Set([...units.filter(kept), ...canary])].sort(),
    journeys: journeys.filter(file => kept(file) && !canary.includes(file)), skipped,
    ...(left.length ? { auditLeft: left } : {}), ...(sealedCells.length ? { sealedCells } : {}), runner: runner?.trim() || 'node --test' };
}

/** Whether a change list carries a file that is global whatever cell it sits in: a manifest or lockfile. */
function isHardGlobal(actual) {
  return !actual || actual.some(file => file === 'package.json' || /(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/u.test(file));
}

/** The sealed-cell confinement of the change from `base` to `commit`, or null; shared by selection and its guard so both read one rule (#5671). */
function confinementOf(root, base, commit, actual, sealedCells) {
  return isHardGlobal(actual) ? null : sealedConfinement(actual, sealedCells, (file, side) => sourceGit(root, ['show', `${side === 'base' ? base : commit}:${file}`], true));
}

/** The generated fixture registry: one row per test file naming the fixtures it uses. */
const [FIXTURE_REGISTRY] = BASELINE_TABLES;
/** The per-file cross-cell import ceilings, a committed listing its writer in edges.js names. */
export { CELLS_EDGES_CEILINGS };

const COMMITTED_LISTINGS = new Set(['packages/gate/data/tests/test-cells.json', CELLS_EDGES_CEILINGS, TEST_TIERS_FILE, FIXTURE_REGISTRY]);
/** The fixture registry keys each row by the test file it serves, so a row is a cell's own when that file lies in the cell (#4638). */
const FILE_KEYED = new Set([FIXTURE_REGISTRY]);
/**
 * The listing sections a tool regenerates from the tree (`--write`), by file; `true` means every section. A static check
 * and the tests that read the file compare them with a fresh run, so a hand edit or a raised ratchet is caught there and
 * a change to them hides no test from selection. The rest, such as journey reasons, audited helpers and plan shards,
 * are policy a person writes, so only a changed cell's own rows count as part of its change (#4633).
 */
const GENERATED_SECTIONS = { 'packages/gate/data/tests/test-cells.json': new Set(['findings', 'rootTests', 'sealed']), [CELLS_EDGES_CEILINGS]: true, [TEST_TIERS_FILE]: true };

/** Whether a changed path is a listing file a cell's work regenerates beside its code. */
function isListing(file) { return COMMITTED_LISTINGS.has(file); }

/** The name the test-cell listing gives a cell root: `<cell>` for `packages/<cell>`, `apps/<name>` for `apps/<name>`. */
function listedCellName(root) { return root.startsWith('apps/') ? root : root.slice('packages/'.length); }

/**
 * The cell roots (`packages/<cell>`, `apps/<cell>`) a change touches when every changed path lies inside a sealed cell,
 * else null; with the listing files that rode along. Why: a sealed cell's tests conform and no outside file imports past
 * its front door, so a change confined to it can reach outside only through that front door (#4003). The listing names an
 * apps cell `apps/<name>`, so that is the name a root is looked up by. A listing file counts as part of the change only
 * when each row it adds, drops or edits belongs to a changed cell (#4633).
 *
 * @param {string[] | null} changed
 * @param {string[]} sealedCells
 * @param {(file: string, side: 'base' | 'head') => string | null} read the file's committed text on the base or the head
 * @returns {{ roots: Set<string>, listings: string[] } | null}
 */
function sealedConfinement(changed, sealedCells, read) {
  if (!changed?.length || !sealedCells.length) return null;
  const sealed = new Set(sealedCells), roots = new Set(), listings = [];
  for (const file of changed) {
    if (isListing(file)) { listings.push(file); continue; }
    const match = /^((?:packages|apps)\/([^/]+))\//u.exec(file);
    if (!match || !sealed.has(listedCellName(match[1]))) return null;
    roots.add(match[1]);
  }
  if (!roots.size || !listings.every(file => listingIsOwn(file, roots, read))) return null;
  return { roots, listings };
}

/** One keyed entry per row of a listing, so two versions compare row by row; a section that is no list of rows is one entry. */
function listingRows(listing) {
  const rows = new Map();
  const add = (section, key, row) => rows.set(`${section}\0${key}`, `${rows.get(`${section}\0${key}`) ?? ''}${JSON.stringify(row)}`);
  for (const [section, value] of Object.entries(listing ?? {})) {
    if (Array.isArray(value)) for (const row of value) add(section, typeof row === 'string' ? row : Array.isArray(row) ? row[1] : row?.file ?? JSON.stringify(row), row);
    else if (value && typeof value === 'object') for (const [key, row] of Object.entries(value)) add(section, key, row);
    else add(section, '', value);
  }
  return rows;
}

/**
 * Whether a listing file's change is part of the changed cells' work: its generated sections are, and every other row
 * must belong to a changed cell, by a file path under its root or its listed name. A shard must be a changed cell's own.
 * A listing that cannot be read refuses.
 */
function listingIsOwn(file, roots, read) {
  const parse = side => { try { const text = read(file, side); return text === null ? null : JSON.parse(text); } catch { return undefined; } };
  const [before, after] = [parse('base'), parse('head')];
  if (before === undefined || after === undefined) return false;
  const names = new Set([...roots].map(listedCellName));
  const owns = key => names.has(key.replace(/^<-/u, '')) || [...roots].some(root => key === root || key.startsWith(`${root}/`));
  const [was, now] = [listingRows(before), listingRows(after)];
  const generated = section => GENERATED_SECTIONS[file] === true || GENERATED_SECTIONS[file]?.has(section);
  return [...new Set([...was.keys(), ...now.keys()])].filter(key => was.get(key) !== now.get(key))
    .every(key => { const section = key.slice(0, key.indexOf('\0')); return generated(section) || owns(key.slice(section.length + 1)) || FILE_KEYED.has(file) && owns(section); });
}

/**
 * The files that read a listing the change carried: any module naming it, and the tests importing that module. A test that
 * reads a listing as input must run when the listing changes, even though a confined change runs no other journey (#4633).
 */
function listingReaders(root, base, commit, listings) {
  const needles = [...new Set(listings.map(file => posix.basename(file)))];
  const before = base ? codeMapGraph(root, base) : null;
  const readers = new Set();
  for (const graph of [before, codeMapGraph(root, commit, before)]) {
    if (!graph) continue;
    for (const [path, source] of graph.modules) {
      if (!needles.some(needle => source.includes(needle))) continue;
      readers.add(path);
      for (const importer of graph.reverse.get(path) ?? []) readers.add(importer);
    }
  }
  return readers;
}

/**
 * A test a confined change selects: one under a changed sealed cell's own tests folder or a unit reaching only the changed
 * cells, or, when a changed cell's front door changed, a contract test of a cell that reaches it. No root journey or other cell's test rides along (#4003).
 */
function confinedUnit(row, roots, doors) {
  if ([...roots].some(cell => row.file.startsWith(`${cell}/tests/`))) return true;
  // A unit that reaches only the changed cells is theirs wherever it sits; anything reaching further waits for its own change.
  if (row.tier === 'T1' && row.packages.length && row.packages.every(name => roots.has(name))) return true;
  const contract = /^((?:packages|apps)\/[^/]+)\/contract\//u.exec(row.file);
  return Boolean(contract) && [...roots].some(cell => doors.has(`${cell}/index.js`) && row.packages.includes(cell));
}

/** The cells the committed test-cell listing at `commit` records as sealed; none when it is absent or unreadable. */
function sealedTestCells(root, commit) {
  try {
    const listing = JSON.parse(sourceGit(root, ['show', `${commit}:packages/gate/data/tests/test-cells.json`]));
    return Array.isArray(listing.sealed) ? listing.sealed.filter(name => typeof name === 'string').sort() : [];
  } catch { return []; }
}

/**
 * Skip each unchanged package with unit tests only by its current seal's receipt; a package with no seal at its current
 * hash joins the run instead (RFC 0006 A3). Before any seal exists nothing is skipped by name (A6).
 */
function sealedSkips(root, seals, manifest, packages) {
  const store = sealStoreFile(root);
  if (!sealsExist(store)) return [];
  const tested = new Set(manifest.files.filter(row => row.tier === 'T1').flatMap(row => row.packages));
  const skipped = [];
  for (const name of seals.kept) {
    if (!tested.has(name) || packages.has(name)) continue;
    const hash = seals.hashes.get(name), receipt = sealOf(store, name, hash)?.receipts[0] ?? null;
    if (receipt) skipped.push({ package: name, hash, receipt });
    else packages.add(name);
  }
  return skipped;
}

/**
 * Refuse a plan whose skipped packages include one the change unseals, or one skipped without a current seal holding
 * its named receipt, so a selection that hides a change fails instead of reporting green (RFC 0006 A3 control).
 * It also refuses a unit test of a package that must run (one the plan names or the change unseals), or a contract at a
 * changed front door, that is missing from the plan's units, and, given `proofFiles`, a unit that neither the check nor the proof files run: an omitted
 * test can never vanish from both units and skipped.
 *
 * @param {string} root
 * @param {{ base?: string | null, commit: string, packages?: string[], units?: string[], runner?: string, skipped?: { package: string, hash?: string, receipt?: string | null }[] }} plan
 * @param {{ proofFiles?: string[], check?: string }} [proof] the files the submit run executes beside its check
 */
export function requireSealedSkips(root, plan, { proofFiles, check } = {}) {
  if (plan?.skipped?.length) requireSkipReceipts(root, plan);
  if (!plan?.units) return;
  const mustRun = new Set(plan.packages ?? []);
  const seals = plan.base ? unsealedPackages(root, { base: plan.base, head: plan.commit }) : null;
  const unsealed = (seals?.unsealed ?? []).filter(row => row.hash).map(row => row.package);
  for (const name of unsealed) mustRun.add(name);
  const after = snapshotAt(root, plan.commit);
  // The same rule the selection uses, so a root-owned cross-package journey is never demanded as a unit (#2596).
  const own = row => ownUnit(row, after, new Set((seals?.unsealed ?? []).filter(row => row.hash).map(row => row.package)));
  // Every contract at a changed front door runs too; the doors come from Git, never from the plan's own change list.
  const changed = plan.base ? sourceGit(root, ['diff', '--no-renames', '--name-only', '-z', plan.base, plan.commit]).split('\0').filter(Boolean) : [];
  const doors = new Set([...(seals?.doors ?? []), ...changed.filter(file => /^(?:packages|apps)\/[^/]+\/index\.js$/u.test(file))]);
  const contractRoots = [...doors].map(door => ownerOf(door, after.packageFiles, after.owners)).filter(Boolean).map(name => `${name}/contract/`);
  const contract = row => contractRoots.some(prefix => row.file.startsWith(prefix));
  // A change confined to sealed cells narrows the units to theirs (#4003), so the guard demands only those; an unsealed
  // package inside the cell still has to select or skip its unit tests (#5671).
  const confined = plan.base ? confinementOf(root, plan.base, plan.commit, changed, sealedTestCells(root, plan.commit)) : null;
  const required = after.manifest.files.filter(row => ((row.tier === 'T1' && row.packages.some(name => mustRun.has(name))) || own(row) || contract(row)) && (!confined || confinedUnit(row, confined.roots, doors))).map(row => row.file);
  const missing = required.filter(file => !plan.units.includes(file)).sort();
  if (missing.length) throw new Refused('TEST_SELECTION_INCOMPLETE', `unit tests of unsealed packages are neither selected nor skipped: ${missing.join(', ')}; select tests from the committed diff`);
  if (!proofFiles) return;
  const unrun = testTierProofFiles(plan, check).filter(file => !proofFiles.includes(file)).sort();
  if (unrun.length) throw new Refused('TEST_SELECTION_INCOMPLETE', `selected unit tests are missing from the submit run: ${unrun.join(', ')}; select tests from the committed diff`);
}

/** Every skip names a package the change leaves sealed, by a receipt its current seal holds. */
function requireSkipReceipts(root, plan) {
  if (!plan.base) throw new Refused('SEAL_STALE', 'a plan that skips sealed packages needs its base; select tests from the committed diff');
  const unsealed = new Set(unsealedPackages(root, { base: plan.base, head: plan.commit }).unsealed.map(row => row.package));
  const hidden = plan.skipped.map(row => row.package).filter(name => unsealed.has(name)).sort();
  if (hidden.length) throw new Refused('SEAL_STALE', `the change unseals skipped packages: ${hidden.join(', ')}; run their tests`);
  const unproven = plan.skipped.filter(row => typeof row.receipt !== 'string' || !row.receipt).map(row => row.package).sort();
  if (unproven.length) throw new Refused('SEAL_STALE', `skipped without a seal receipt: ${unproven.join(', ')}; run their tests`);
  const store = sealStoreFile(root);
  checkSkippedSeals(root, { rev: plan.commit, skipped: plan.skipped.map(row => row.package), store });
  const moved = plan.skipped.filter(row => !sealOf(store, row.package, row.hash)?.receipts.includes(row.receipt)).map(row => row.package).sort();
  if (moved.length) throw new Refused('SEAL_STALE', `skipped by a receipt their current seal does not hold: ${moved.join(', ')}; run their tests`);
}

/** Quote a selected path without permitting shell interpolation. */
function word(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/** An exact complete frozen file run already proves its unit files; filtered or opaque commands do not. */
export function testTierProofFiles(plan, check) {
  const prefix = literalShellWords(plan.runner), command = check && literalShellWords(check);
  const suffix = prefix && command && prefix.every((word, index) => command[index] === word) ? command.slice(prefix.length) : null;
  const covered = suffix?.length && suffix.every(file => !file.startsWith('-') && !/[?*[]/u.test(file)) ? suffix.map(file => posix.normalize(file)) : [];
  return plan.units.filter(file => !covered.includes(file));
}

/** Use the declared focused runner for the selected unit or journey files. */
export function testTierCommand(plan, files) {
  return files.length ? `${plan.runner} ${files.map(file => word('./' + file)).join(' ')}` : '';
}

/** Preserve the frozen check and append only units it did not already run completely. */
export function testTierCheckCommand(check, plan) {
  const units = testTierCommand(plan, testTierProofFiles(plan, check));
  return [check, units].filter(Boolean).map(command => `(\n${command}\n)`).join(' && ');
}

/**
 * Show exactly which units run and which journeys await the landing batch. A red refusal passes `names: false`:
 * it counts the units and lets the failing cases, each with its first error line, be the only tests it names.
 */
export function testTierReport(plan, { names = true } = {}) {
  const units = names ? `T1 unit tests (${plan.units.length}): ${plan.units.join(', ') || 'none'}` : `T1 unit tests: ${plan.units.length} ran; the failing cases follow, the rest are in the full log`;
  const skipped = plan.skipped?.length ? `\nSealed packages skipped (${plan.skipped.length}): ${plan.skipped
    .map(row => `${row.package} by receipt ${row.receipt}`).join(', ')}` : '';
  const sealed = plan.sealedCells?.length ? `\nCells sealed by conforming tests (${plan.sealedCells.length}): ${plan.sealedCells.join(', ')}` : '';
  const audit = plan.auditLeft?.length ? `\nLeft to the main audit (landing.auditOnly) (${plan.auditLeft.length}): ${plan.auditLeft.join(', ')}` : '';
  return `${units}\nT3 journeys deferred to the landing batch (${plan.journeys.length})${skipped}${sealed}${audit}`;
}

/**
 * A green exit with no observed test account cannot prove a selected unit or journey. The refusal names the selected
 * files the run gave no account for, so a runner that ignored them is found by name, on the controller and on a pulled gate.
 */
export function requireTestTierAccount(run, files) {
  const green = run.isGreen === true || run.green === true || run.state === 'pass';
  const outcomes = testOutcomeFields(run.profile?.testOutcomes) ?? testOutcomeFields(run.testOutcomes);
  const missing = outcomes
    ? files.filter(file => !outcomes.some(row => row.file === posix.normalize(file)))
    : run.profile?.tests?.length ? [] : [...files];
  if (green && files.length && missing.length) {
    const named = missing.slice(0, 20).join(', ') + (missing.length > 20 ? ` and ${missing.length - 20} more` : '');
    throw new Refused('TEST_SELECTION_UNVERIFIED', `selected test files produced no test account (${missing.length} of ${files.length} unreported: ${named}); make the focused runner execute and report the selected tests`);
  }
}
