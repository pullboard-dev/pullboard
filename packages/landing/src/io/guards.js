/** Validate the composed source before any landing publication [B35]. */
import { addedPlacementProblems } from '../../../codemap/index.js';
import { cellInventory } from '../../../codemap/index.js';
import { readPlan } from '../../../codemap/index.js';
import { unplanned } from '../../../codemap/index.js';
import { updateCellInventory } from '../../../codemap/index.js';
import { addedLines } from '../../../commits/index.js';
import { secretsIn } from '../../../commits/index.js';
import { commonJsIn } from '../../../gate/index.js';
import { importsIn } from '../../../gate/index.js';
import { git } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { tryGit } from '../../../git/index.js';
import { composeItemPatches } from '../../../items/index.js';
import { Refused } from '../../../kernel/index.js';
import { getItem } from '../../../store/index.js';
import { itemPatches } from '../../../store/index.js';
import { withMainCheckout } from './main/red.js';

const graphs = new Map();
/** Imports of each source; a source that does not compile imports nothing provable, as the seal graph also treats it (#2438). */
function tolerantImportsIn(sources) {
  try { return importsIn(sources); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    return sources.map(source => {
      try { return importsIn([source])[0]; }
      catch (failure) { if (failure.message !== 'source does not compile as an ES module') throw failure; return []; }
    });
  }
}

const parsers = { importsIn: tolerantImportsIn, commonJsIn };

/** Check all ordered companion effects as one patch set, allowing unrelated later main edits. */
export function requireLandingCompanions(root, board, entries, tip) {
  const tree = git(root, ['rev-parse', `${tip}^{tree}`]);
  for (const entry of entries) {
    const item = getItem(board, entry.id ?? entry.item_id);
    const patches = itemPatches(board, item.item_id);
    if (!patches.length) continue;
    const expected = composeItemPatches(root, item, patches);
    const merged = tryGit(root, ['merge-tree', '--write-tree', `--merge-base=${item.item_commit}`, tip, expected.commit]);
    if (!Number.isInteger(merged.status) || merged.status < 0 || merged.status > 1) throw new Refused('LAND_COMPANION_SOURCE', `cannot read the exact companion composition for #${item.item_id}; restore its Git objects before landing`);
    if (merged.status !== 0 || merged.stdout.split('\n')[0] !== tree) {
      throw new Refused('LAND_COMPANION_MISSING', `landing #${item.item_id} does not contain its complete attached companion set; rebuild the batch from the checked composition`);
    }
  }
}

/** Cache only immutable source trees, and update importer edges when an imported target disappears. */
async function graphAt(root, commit, prior, changed) {
  const key = `${repoInfo(root).commonDir}:${git(root, ['rev-parse', `${commit}^{tree}`])}`;
  if (graphs.has(key)) return graphs.get(key);
  const graph = await withMainCheckout(root, commit, checkout => prior
    ? updateCellInventory(checkout, parsers, prior, changed) : cellInventory(checkout, parsers));
  if (graph?.unavailable) throw new Refused('LAND_MODULE_SOURCE', `cannot inspect exact landing modules: ${graph.unavailable}; restore the source and retry`);
  graphs.set(key, graph);
  if (graphs.size > 8) graphs.delete(graphs.keys().next().value);
  return graph;
}

/** A literal local import is a resolution failure; computed loaders remain the full gate's responsibility. */
function missingImports(graph) {
  return graph.unknown.filter(row => /^missing import target /u.test(row.reason ?? ''));
}

/** Identify inherited main debt without exempting a new importer or a newly deleted target. */
function edgeKey(row) { return JSON.stringify([row.file, row.specifier, row.reason]); }

/**
 * The changed ES modules that do not parse alone at the composed tip.
 * Why: the inventory reads through tolerantImportsIn, which treats an uncompilable source as importing nothing, so the
 * parse failure must be found here, directly, or a duplicate import lands [C7].
 */
function brokenModules(root, tip, changed) {
  return changed.filter(file => /\.(?:m?js)$/u.test(file)).filter(file => {
    const shown = tryGit(root, ['show', `${tip}:${file}`]);
    if (shown.status !== 0) return false;
    try { importsIn([shown.stdout], undefined); return false; } catch { return true; }
  });
}

/**
 * The refusal for a composed module that does not parse, naming the changed files that fail alone.
 * Why: a duplicate import in a composition killed the worker as LAND_WORKER, which blamed no item and left the batch
 * pinned in merging; a parse failure is the composed content's own and ends the batch terminally [C7].
 */
function parseRefusal(root, tip, changed, broken = brokenModules(root, tip, changed)) {
  const refusal = new Refused('LAND_MODULE_PARSE', `the composed landing has ${broken.length ? broken.join(', ') : 'a module'} that does not parse as an ES module; fix the duplicate or invalid declaration and resubmit`);
  refusal.broken = broken;
  return refusal;
}

/**
 * Refuse a composed landing whose lines added over `base` hold a possible secret, naming each file:line and never the value.
 * Why: the pre-commit scan is skipped by a --no-verify commit, so landing reruns the same scanner before main moves [#5968].
 */
export function requireLandingSecretFree(root, base, tip) {
  const diff = git(root, ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '-U0', base, tip], { maxBuffer: 1 << 28 });
  const found = secretsIn(addedLines(diff));
  if (!found.length) return;
  const refusal = new Refused('LANDING_SECRET', `the composed landing adds a possible secret: ${found.join('; ')}`, 'remove the value from the item\'s commits (rewrite them, never add a revert) and resubmit');
  refusal.found = found;
  throw refusal;
}

/** Inspect source only: no candidate module is imported or evaluated before main moves; secrets are refused first [#5968]. */
export async function requireLandingModuleResolution(root, base, tip) {
  requireLandingSecretFree(root, base, tip);
  const before = await graphAt(root, base);
  const changed = git(root, ['diff', '--no-renames', '--name-only', '-z', base, tip]).split('\0').filter(Boolean);
  const broken = brokenModules(root, tip, changed);
  if (broken.length) throw parseRefusal(root, tip, changed, broken);
  let after;
  try { after = await graphAt(root, tip, before, changed); }
  catch (error) {
    if (error.message !== 'source does not compile as an ES module') throw error;
    throw parseRefusal(root, tip, changed);
  }
  const inherited = new Set(missingImports(before).map(edgeKey));
  const missing = missingImports(after).filter(row => !inherited.has(edgeKey(row)));
  if (missing.length) throw new Refused('LAND_MODULE_RESOLUTION', `the composed landing leaves missing module targets: ${missing.map(row => `${row.file}: ${row.specifier} (${row.reason})`).join('; ')}; restore or repoint every importer before landing`);
}

/** The placement problems the composed tree at `root` adds over `base`: tracked sources with no cells-plan row [C7,#5559]. */
export function landingPlacementProblems(root, base) {
  return withMainCheckout(root, base, checkout => addedPlacementProblems(checkout, root, { unplanned, readPlan }));
}
