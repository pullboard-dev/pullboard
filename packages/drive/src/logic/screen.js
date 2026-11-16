/** Pure naming and reading of the screen job: one sprint item's commit merged on its base and re-checked by trusted code [V16,M1]. */

/** The job kind that screens a sprint item at its commit on the current base. */
export const SCREEN_KIND = 'screen';

/**
 * The content key of one screen: the item's commit, its frozen digest and the base it is merged onto.
 * Why: the same commit on a moved base is a new screen, and a re-screen of the same pair reuses the stored receipt.
 *
 * @param {{ commit: string, digest?: string | null, base: string }} at
 * @returns {string}
 */
export function screenKey({ commit, digest, base }) {
  return `${commit}:${digest ?? '-'}@${base}`;
}

/**
 * Whether an item is screened at all: only items frozen at pace sprint, so a steady or strict board never sees a screen job.
 *
 * @param {{ pace?: string | null } | null | undefined} item
 * @returns {boolean}
 */
export function screenQueued(item) {
  return item?.pace === 'sprint';
}

/**
 * The screen receipt from what the runner saw: green only when the merge is clean, the static checks pass and the
 * re-check names nothing. Each finding is one line naming its check, so a red receipt says why.
 * Why one shape: the landing rows read it through receiptCounts and the `irreversibleChecked` row reads `checks`.
 *
 * @param {{ item: number, commit: string, digest?: string | null, base: string, conflicts: string[] | null,
 *   staticRun: { status: 'green' | 'red' | 'skipped', problem?: string } | null,
 *   rechecked: { commit: string, kind: 'secret' | 'header', problem: string }[] | null, leased: boolean }} seen
 *   conflicts: null when the merge was clean; staticRun and rechecked: null when the merge stopped them.
 * @returns {{ kind: 'screen', item: number, commit: string, digest: string | null, base: string, green: boolean, trusted: true, leased: boolean,
 *   checks: { merge: string, static: string, secrets: string, hooks: string }, findings: string[] }}
 */
export function screenReceipt({ item, commit, digest = null, base, conflicts, staticRun, rechecked, leased }) {
  const findings = [];
  if (conflicts) findings.push(`merge: conflict with ${base} in ${conflicts.length ? conflicts.join(', ') : 'the tree'}`);
  if (staticRun?.status === 'red') findings.push(`static: ${staticRun.problem ?? 'the static checks failed'}`);
  for (const found of rechecked ?? []) findings.push(`${found.kind === 'secret' ? 'secrets' : 'hooks'}: ${found.commit.slice(0, 12)} ${found.problem}`);
  const ran = (list, kind) => (list === null ? 'not-run' : list.some(found => found.kind === kind) ? 'red' : 'green');
  const checks = {
    merge: conflicts ? 'red' : 'green',
    static: staticRun === null ? 'not-run' : staticRun.status === 'red' ? 'red' : 'green',
    secrets: ran(rechecked, 'secret'),
    hooks: ran(rechecked, 'header'),
  };
  const green = Object.values(checks).every(state => state === 'green');
  return { kind: SCREEN_KIND, item, commit, digest, base, green, trusted: true, leased, checks, findings };
}
