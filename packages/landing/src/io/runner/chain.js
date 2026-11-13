/** A chained landing job: build on the parent candidate, drop only a culprit, push by compare-and-swap after the parent lands [C7]. */
import { tryGit } from '../../../../git/index.js';
import { LANDING_JOB_KIND } from './job.js';
import { commandCheck } from './job.js';
import { fetchItem } from './job.js';
import { fetchTrunk } from './job.js';
import { landingCheckout } from './job.js';
import { landingMergeArgs } from './job.js';
import { must } from './job.js';
import { pushTrunk } from './job.js';

/**
 * The red-judge seam until L1 (#5862) supplies its own: the check's named culprit, else the batch's last item. L1's
 * judge decides charged-to-main and quarantine (answer `{ green: true }`) or a culprit with its failing cases; this
 * job only acts on the answer and never judges a red itself.
 */
export function returnLastItem({ items, result }) {
  return { culprit: result?.culprit ?? items.at(-1), detail: result?.detail ?? 'the landing check failed' };
}

/** True when `commit` is already on `tip`, so a retaken or rebuilt job never merges it twice. */
const onTip = (root, commit, tip) => tryGit(root, ['merge-base', '--is-ancestor', commit, tip]).status === 0;
const treeOf = (root, commit) => must(root, ['rev-parse', `${commit}^{tree}`]);

/** Merge entries onto `base` in order; stop at the first that does not merge and name it. */
function mergeOnto(root, base, entries) {
  must(root, ['checkout', '-q', '--detach', '--force', base]);
  must(root, ['clean', '-q', '-fd']);
  for (const entry of entries) {
    const merged = tryGit(root, landingMergeArgs(root, entry));
    if (merged.status !== 0) {
      tryGit(root, ['merge', '--abort']);
      return { tip: null, conflict: entry, detail: (merged.stdout || merged.stderr).slice(0, 240) };
    }
  }
  return { tip: must(root, ['rev-parse', 'HEAD']), conflict: null, detail: null };
}

/**
 * Build a candidate on `base`: merge its items, run the check, and on a red ask the judge; drop only the culprit it
 * names (or an item that does not merge) and build again without it, until the rest is green or nothing is left.
 */
async function buildCandidate(root, base, entries, { check, judge, renew }) {
  let kept = entries.filter(entry => !onTip(root, entry.commit, base));
  const returned = [];
  // Each round lands the rest or drops one item, so the rounds end within one more than the batch's size.
  for (let round = 0; round <= entries.length; round++) {
    if (kept.length === 0) return { tip: base, kept, returned, leaseLost: false };
    const merged = mergeOnto(root, base, kept);
    if (merged.conflict) {
      returned.push({ id: merged.conflict.id, reason: 'conflict', detail: merged.detail });
      kept = kept.filter(entry => entry !== merged.conflict);
      continue;
    }
    if (!await renew()) return { tip: null, kept, returned, leaseLost: true };
    const result = await check({ root, base, items: kept.map(entry => entry.id), renew });
    if (result?.ok) return { tip: merged.tip, kept, returned, leaseLost: false };
    const verdict = await judge({ root, base, items: kept.map(entry => entry.id), result });
    if (verdict?.green) return { tip: merged.tip, kept, returned, leaseLost: false };
    const culprit = kept.find(entry => entry.id === verdict?.culprit) ?? kept.at(-1);
    returned.push({ id: culprit.id, reason: 'red', detail: verdict?.detail ?? result?.detail ?? null });
    kept = kept.filter(entry => entry !== culprit);
  }
  return { tip: base, kept: [], returned, leaseLost: false };
}

/**
 * Land one chained candidate from a runner. While its parent proves, the job speculates: it merges the candidates
 * below it (`below`) onto `expect`, then its own items on top, and proves that tree, dropping only culprits. When the
 * parent lands, it fetches trunk: a trunk whose tree is the one it speculated on keeps its proof and only replays its
 * merges on the real tip; any other trunk (the parent dropped a culprit) rebuilds its items there and proves again.
 * The push is git's compare-and-swap, `--force-with-lease=<trunk>:<parent's tip>`, so it lands only on its parent.
 *
 * @param {{ remote: string, trunk: string, expect: string, parent?: string | null, below?: { id: number, commit: string, ref?: string }[],
 *   items: { id: number, commit: string, ref?: string }[], check?: string[], checkout?: boolean }} payload
 * @param {{ workdir: string, checks?: Function | null, judge?: typeof returnLastItem, renew?: () => boolean | Promise<boolean>,
 *   awaitParent?: (parent: string) => Promise<{ outcome: string, trunk: string | null }>, pushOptions?: () => string[] }} options - awaitParent: resolves once
 *   the parent candidate's job has a receipt; judge: the single seam to L1's red outcome; pushOptions: the lease's landing permit (#5848).
 * @returns {Promise<{ kind: string, outcome: 'landed' | 'returned' | 'item-moved' | 'parent-failed' | 'replan' | 'lease-lost',
 *   parent: string | null, expect: string, base: string | null, trunk: string | null, landed: number[], returned: { id: number, reason: string, detail: string | null }[],
 *   already: number[], rebuilt: boolean, pushes: number, detail: string | null }>}
 */
export async function runChainedLandingJob(payload, { workdir, checks = null, judge = returnLastItem, renew = () => true, awaitParent = null, pushOptions = () => [] }) {
  const { remote, trunk, expect, items, below = [], parent = null } = payload;
  const check = checks ?? (payload.check ? commandCheck(payload.check) : () => ({ ok: true, detail: null }));
  const root = landingCheckout(workdir);
  const receipt = { kind: LANDING_JOB_KIND, outcome: 'replan', parent, expect, base: null, trunk: null, landed: [], returned: [], already: [], rebuilt: false, pushes: 0, detail: null };
  const done = (outcome, fields = {}) => Object.assign(receipt, { outcome }, fields);
  for (const entry of [...below, ...items]) {
    const fetched = fetchItem(root, remote, entry);
    if (fetched.moved) return done('item-moved', { detail: `#${entry.id}: ${fetched.moved}` });
  }
  fetchTrunk(root, remote, trunk);
  // Speculate: the parent's tree as planned. A below item that does not merge here is the parent's culprit to drop.
  let speculated = expect;
  for (const entry of below) {
    const merged = mergeOnto(root, speculated, [entry]);
    if (merged.tip) speculated = merged.tip;
  }
  let built = await buildCandidate(root, speculated, items, { check, judge, renew });
  if (built.leaseLost) return done('lease-lost', { detail: 'the job\'s lease moved to another runner during its proof' });
  if (parent) {
    const landed = awaitParent ? await awaitParent(parent) : null;
    if (!landed || !['landed', 'returned'].includes(landed.outcome)) {
      return done('parent-failed', { detail: `parent ${parent} ended ${landed?.outcome ?? 'without a receipt'}; plan this candidate again` });
    }
  }
  const tip = fetchTrunk(root, remote, trunk);
  receipt.base = tip;
  receipt.already = items.filter(entry => onTip(root, entry.commit, tip)).map(entry => entry.id);
  // Speculative verdicts hold only when the parent landed exactly the tree they ran on: then replay the same merges on
  // the real tip and keep the proof if the replay reaches the proved tree. Otherwise every own item builds again on
  // the real tip, since a speculative red may have come from a culprit below that the parent dropped.
  let kept = null;
  if (treeOf(root, tip) === treeOf(root, speculated)) {
    kept = built.kept.filter(entry => !receipt.already.includes(entry.id));
    const replay = kept.length > 0 ? mergeOnto(root, tip, kept) : { tip };
    if (replay.tip && (kept.length === 0 || treeOf(root, replay.tip) === treeOf(root, built.tip))) built = { ...built, tip: replay.tip, kept };
    else kept = null;
  }
  if (kept === null) {
    receipt.rebuilt = true;
    built = await buildCandidate(root, tip, items.filter(entry => !receipt.already.includes(entry.id)), { check, judge, renew });
    if (built.leaseLost) return done('lease-lost', { detail: 'the job\'s lease moved to another runner during its rebuild' });
  }
  receipt.returned = built.returned;
  if (built.kept.length === 0) return done(built.returned.length > 0 ? 'returned' : 'landed', { trunk: tip });
  if (!await renew()) return done('lease-lost', { detail: 'the job\'s lease moved to another runner before the push' });
  const pushed = pushTrunk(root, { payload, trunk, base: tip, remote, source: built.tip, options: pushOptions() });
  if (pushed.status !== 0) return done('replan', { detail: `trunk is no longer ${tip.slice(0, 12)}: ${(pushed.stderr || pushed.stdout).slice(0, 240)}` });
  return done('landed', { trunk: built.tip, landed: built.kept.map(entry => entry.id), pushes: 1 });
}
