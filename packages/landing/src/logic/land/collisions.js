/** Match accepted candidates by their reviewed Git merge changes, never declared brief paths [B3,R3]. */
import { tryGit } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

/** Preview one reviewed commit against the immutable trunk, including both sides of a rename. */
export function landingChangedFiles(root, base, commit) {
  const merged = tryGit(root, ['merge-tree', '--write-tree', '-z', base, commit]);
  const tree = merged.stdout.split('\0')[0];
  if (![0, 1].includes(merged.status) || !/^[a-f0-9]{40,64}$/u.test(tree)) {
    throw new Refused('LAND_MERGE', 'Git could not read the reviewed landing paths; restore its objects before composing the batch');
  }
  // Name-status starts with an ASCII status, so tryGit's trim cannot alter a leading-space path.
  // The final NUL also preserves trailing path whitespace; no-renames makes old and new paths explicit.
  const diff = tryGit(root, ['diff', '--name-status', '--no-renames', '-z', base, tree]);
  const fields = diff.stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (diff.status !== 0 || fields.length % 2 || fields.some((value, index) => index % 2 === 0
    ? !/^[ADMTUXB]$/u.test(value) : !value)) {
    throw new Refused('LAND_MERGE', 'Git could not read the reviewed landing paths; restore its objects before composing the batch');
  }
  return fields.filter((_, index) => index % 2 === 1);
}

/** Retain deferred queue places only for the identical accepted source and frozen bar. */
export function deferredLandingPriorities(batches, items) {
  const pending = new Map(items.map(item => [item.item_id, item]));
  const priorities = new Map();
  for (const batch of batches) {
    if (batch.state !== 'landed') continue;
    for (const entry of batch.blocked ?? []) {
      const item = pending.get(entry.id);
      if (entry.code !== 'LAND_FILE_OVERLAP' || !item || item.item_status !== 'verified' || item.item_merged_commit
        || typeof entry.commit !== 'string' || entry.commit !== item.item_commit
        || typeof entry.frozenDigest !== 'string' || entry.frozenDigest !== item.item_frozen_digest) continue;
      if (!priorities.has(entry.id)) priorities.set(entry.id, priorities.size);
    }
  }
  return priorities;
}
