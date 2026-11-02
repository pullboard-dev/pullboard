/** Select testing tiers from immutable source; caller hints never hide a changed package [C7,CS4,V4]. */
import { gitSpawnSync } from '../../../git/index.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posix } from 'node:path';
import { cleanGitEnvironment } from '../../../git/index.js';
import { testOutcomeFields } from './test-outcomes.js';
import { Refused } from '../../../kernel/index.js';
import { literalShellWords } from '../../../kernel/index.js';
import { generateTestTiers } from './test-tiers.js';
import { ownerOf } from './test-tiers.js';
import { TEST_TIERS_FILE } from './test-tiers.js';

const snapshots = new Map();
const TEST_HELPER = /(?:^|\/)(?:test|tests)\//u;

/** Read exact Git objects or construct an isolated read view without executing project hooks. */
function sourceGit(root, args, optional = false) {
  const result = gitSpawnSync(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env: { ...cleanGitEnvironment(), GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout;
  if (optional) return null;
  throw new Refused('TEST_SELECTION_SOURCE', 'the immutable test-selection source could not be read; restore Git history and retry');
}

/** Resolve one immutable commit instead of retaining a movable ref inside the selection. */
function commitAt(root, ref) {
  const commit = sourceGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Refused('TEST_SELECTION_SOURCE', 'test selection needs a real committed source');
  return commit;
}

/** The checked-in portable manifest enables tiers for any project; older projects keep their existing gate. */
export function hasTestTiers(root, commit = 'HEAD') {
  return sourceGit(root, ['cat-file', '-e', `${commit}:${TEST_TIERS_FILE}`], true) !== null;
}

/** Recompute classifications and ownership from the exact source, including stale or edited manifest rows. */
function snapshotAt(root, commit) {
  const common = sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const key = `${common}:${commit}`;
  if (snapshots.has(key)) return snapshots.get(key);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-test-tiers-'));
  const checkout = join(directory, 'source');
  try {
    sourceGit(root, ['clone', '--quiet', '--shared', '--no-checkout', '--', common, checkout]);
    sourceGit(checkout, ['checkout', '--quiet', '--detach', commit]);
    let owners, packageFiles;
    const helpers = new Map();
    const manifest = generateTestTiers(checkout, {
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
    snapshots.set(key, result);
    if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value);
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Select only units belonging to changed packages and defer every current journey to the batch. */
export function selectTestTiers(root, { base, trunk, commit = 'HEAD', changed, runner = 'node --test' } = {}) {
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
  const after = snapshotAt(root, commit), before = base ? snapshotAt(root, base) : after;
  const packages = new Set();
  const global = !actual || actual.some(file => file === 'package.json' || /(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/u.test(file) || file.startsWith('bin/cells-plan'));
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
  const units = after.manifest.files.filter(row => row.tier === 'T1' && row.packages.some(name => packages.has(name))).map(row => row.file);
  const journeys = after.manifest.files.filter(row => row.tier === 'T3').map(row => row.file);
  return { version: 1, commit, packages: [...packages].sort(), changed: actual ?? [], units, journeys, runner: runner?.trim() || 'node --test' };
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

/** Show exactly which units run and which journeys await the landing batch. */
export function testTierReport(plan) {
  return `T1 unit tests (${plan.units.length}): ${plan.units.join(', ') || 'none'}\nT3 journeys deferred to the landing batch (${plan.journeys.length})`;
}

/** A green exit with no observed test account cannot prove a selected unit or journey. */
export function requireTestTierAccount(run, files) {
  const green = run.isGreen === true || run.green === true || run.state === 'pass';
  const outcomes = testOutcomeFields(run.profile?.testOutcomes) ?? testOutcomeFields(run.testOutcomes);
  const accounted = outcomes
    ? files.every(file => outcomes.some(row => row.file === posix.normalize(file)))
    : Boolean(run.profile?.tests?.length);
  if (green && files.length && !accounted) throw new Refused('TEST_SELECTION_UNVERIFIED', 'selected test files produced no test account; make the focused runner execute and report the selected tests');
}
