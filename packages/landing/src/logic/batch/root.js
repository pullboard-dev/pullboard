/** Which active landing batch owns a worktree root, and the verified items it lands: pure reads of batch records [B3,V4]. */

/** Recognize only the exact worktrees registered by an active canonical landing batch. */
export function landingBatchOwnsRoot(batch, root) {
  if (['landed', 'blocked'].includes(batch.state)) return false;
  return batch.root === root || (batch.parallelCandidates ?? []).some(candidate => candidate.snapshot?.root === root
    && candidate.snapshot.base === batch.base && candidate.snapshot.branch === batch.branch);
}

/** Select only exact verified sources and checked heads owned by this active landing worktree, including a concurrent recorded merge. */
export function landingBatchItemsAtRoot(batches, root, items, checkedCommit) {
  const entries = batches.flatMap(batch => {
    if (['landed', 'blocked'].includes(batch.state)) return [];
    const snapshot = batch.root === root ? batch : (batch.parallelCandidates ?? [])
      .map(candidate => candidate.snapshot)
      .find(candidate => candidate?.root === root && candidate.base === batch.base && candidate.branch === batch.branch);
    if (!snapshot || ['landed', 'blocked'].includes(snapshot.state)) return [];
    return snapshot.state === 'merging' ? snapshot.candidates ?? snapshot.items ?? [] : snapshot.items ?? [];
  });
  return items.filter(item => item.item_status === 'verified'
    && entries.some(entry => entry.id === item.item_id && entry.commit === item.item_commit
      && (entry.reviewedCommit ?? entry.commit) === checkedCommit(item)));
}
