/** Match a recorded event to its declared move, including state-specific native aliases. */
export function lifecycleMove(machine, state, event) {
  const aliases = { renew: 'claim', 'merge-only-accept': 'submit-merge', rehome_import: 'rehomeImport', 'outside-intake': 'intake' };
  const verb = ['item_patch_attach', 'item_patch_remove'].includes(event.kind)
    ? state === 'claimed' ? 'patch-claimed' : 'patch' : aliases[event.kind] ?? event.kind;
  return machine.moves.find(move => move.verb === verb && move.from.includes(state)
    && (verb !== 'claim' || (event.kind === 'renew') === (move.to === state))
    && (verb !== 'refreeze' || (event.retainedClaim === true) === (move.to === 'claimed')));
}

