/**
 * Match a recorded event to its declared move, including state-specific native aliases.
 * A submit's own lease renewal keeps the item where it is and is no re-claim, so it matches no move.
 */
export function lifecycleMove(machine, state, event) {
  if (event.kind === 'renew' && event.submitRenewal === true) return undefined;
  // An owning lane's objection to an automatic companion reopens the item through its declared move (#3815).
  const aliases = { renew: 'claim', 'merge-only-accept': 'submit-merge', rehome_import: 'rehomeImport', 'outside-intake': 'intake', item_patch_object: 'patch-objected' };
  const verb = ['item_patch_attach', 'item_patch_remove'].includes(event.kind)
    ? state === 'claimed' ? 'patch-claimed' : 'patch' : aliases[event.kind] ?? event.kind;
  return machine.moves.find(move => move.verb === verb && move.from.includes(state)
    && (verb !== 'claim' || (event.kind === 'renew') === (move.to === state))
    && (verb !== 'refreeze' || (event.retainedClaim === true) === (move.to === 'claimed')));
}

/** Preserve the lifecycle facts recorded by the board without exposing unrelated event details. */
export function lifecycleEvent(event) {
  const projected = { kind: event.event_kind, by: event.event_by, at: event.event_at };
  if (event.event_kind === 'refreeze' && JSON.parse(event.event_detail).retainedClaim === true) projected.retainedClaim = true;
  if (['claim', 'renew'].includes(event.event_kind)) {
    try {
      const lease = JSON.parse(event.event_detail).leaseUntil;
      projected.leaseUntil = typeof lease === 'string' && lease.length <= 64 && Number.isFinite(Date.parse(lease)) ? lease : null;
      // A renewal that carries a submit's admission witness is the submit holding its lease, not a re-claim.
      if (event.event_kind === 'renew' && JSON.parse(event.event_detail).submitAdmission) projected.submitRenewal = true;
    }
    catch { projected.leaseUntil = null; /* Malformed legacy claim metadata cannot prove a live lease. */ }
  }
  return projected;
}

/**
 * Replay an item's recorded events through the declared lifecycle, as the view's timeline does
 * (M1). The board logs a claim on a claimed item as renew, and never the clock's lapse, so a move
 * that cannot start where the replay stands, or a status the history does not reach, puts the
 * lapse in first.
 *
 * @param {any} machine Canonical lifecycle declaration, supplied by the actual composition root.
 * @param {{ kind: string, at: string }[]} history
 * @param {string} status
 * @returns {{ from: string, move: object | null, at: string | null }[]}
 */
export function lifecycleSteps(machine, history, status) {
  const steps = [];
  const clockMoves = machine.moves.filter(move => move.by.includes('clock'));
  let at = machine.initial;
  /** Record where the replay stands and the move it makes, if any, then follow that move. */
  const step = (move, event) => {
    steps.push({ from: at, move, at: event ? event.at : null });
    if (move) at = move.to;
  };
  for (const event of history) {
    /** Use the same native-event matcher as snapshot replay. */
    const fits = state => lifecycleMove(machine, state, event);
    const lapse = fits(at) ? null : clockMoves.find((move) => move.from.includes(at) && fits(move.to));
    if (lapse) step(lapse, null);
    step(fits(at) || null, event);
  }
  const lapse = at === status ? null : clockMoves.find((move) => move.from.includes(at) && move.to === status);
  if (lapse) step(lapse, null);
  return steps;
}

/** Read the last stage from the complete recorded lifecycle, never the withdrawn row's current state. */
export function recordedWithdrawalFrom(machine, history, status) {
  if (status !== 'withdrawn' || !history.some(event => ['add', 'intake', 'outside-intake'].includes(event.kind))) return null;
  const from = lifecycleSteps(machine, history, status).findLast(step => step.move?.verb === 'withdraw')?.from ?? null;
  if (from !== 'claimed') return from;
  const index = history.findLastIndex(event => event.kind === 'withdraw');
  const claim = history.slice(0, index).findLast(event => ['claim', 'renew'].includes(event.kind));
  const deadline = typeof claim?.leaseUntil === 'string' ? Date.parse(claim.leaseUntil) : NaN;
  const at = Date.parse(history[index]?.at);
  if (!Number.isFinite(deadline) || !Number.isFinite(at)) return null;
  if (at < deadline) return from;
  const lapse = machine.moves.find(move => move.verb === 'lapse' && move.by.includes('clock') && move.from.includes(from));
  return lapse && machine.moves.some(move => move.verb === 'withdraw' && move.from.includes(lapse.to)) ? lapse.to : null;
}

