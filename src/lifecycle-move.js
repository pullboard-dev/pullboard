/** Match a recorded event to its declared move, including state-specific native aliases. */
export function lifecycleMove(machine, state, event) {
  const aliases = { renew: 'claim', 'merge-only-accept': 'submit-merge', rehome_import: 'rehomeImport', 'outside-intake': 'intake' };
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
  return lifecycleSteps(machine, history, status).findLast(step => step.move?.verb === 'withdraw')?.from ?? null;
}

