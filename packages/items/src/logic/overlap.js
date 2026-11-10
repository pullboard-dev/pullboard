import { briefFiles } from './brief.js';

/** Extract the concrete paths a criterion or plan names, without treating arbitrary prose as ownership. */
export function namedItemPaths(item) {
  const text = `${item.item_criterion ?? ''} ${item.item_title ?? ''}`;
  const named = text.match(/(?:[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*/gu) ?? [];
  return [...new Set([...briefFiles(item.item_brief ?? ''), ...named])];
}

/** Project real observations separately from replayed item state; unreadable seats remain unknown. */
export function claimOverlaps(items, observations) {
  const claims = items.filter(item => item.item_status === 'claimed');
  const result = new Map(claims.map(item => [item.item_id, { files: observations.get(item.item_id)?.files ?? [],
    unknown: observations.get(item.item_id)?.unknown !== false, overlaps: [], outOfScope: [] }]));
  // Each item's named paths are read once per call, not once per claim: claim and next run this on every board size.
  const named = new Map();
  const namesOf = other => { if (!named.has(other.item_id)) named.set(other.item_id, namedItemPaths(other)); return named.get(other.item_id); };
  for (const item of claims) {
    const own = result.get(item.item_id);
    if (!own.files.length) continue;
    for (const other of items) {
      // Only a claim or an open item can overlap; landed and withdrawn items are never read.
      if (other.item_id === item.item_id || !['claimed', 'open'].includes(other.item_status)) continue;
      const paths = other.item_status === 'claimed' ? result.get(other.item_id).files : namesOf(other);
      const shared = own.files.filter(path => paths.includes(path)).sort();
      if (!shared.length) continue;
      if (other.item_status === 'claimed') own.overlaps.push({ item: other.item_id, builder: other.item_owner, files: shared });
      else if (other.item_status === 'open') {
        const scope = new Set(namesOf(item));
        const outside = shared.filter(path => !scope.has(path));
        if (outside.length) own.outOfScope.push({ item: other.item_id, files: outside });
      }
    }
  }
  return result;
}

/** An open item waits only while a claimed worktree actually changes one of its named files. */
export function liveClaimCollisions(item, items, observations) {
  const names = new Set(namedItemPaths(item));
  return items.filter(other => other.item_status === 'claimed' && other.item_id !== item.item_id)
    .flatMap(other => {
      const files = (observations.get(other.item_id)?.files ?? []).filter(path => names.has(path)).sort();
      return files.length ? [`#${item.item_id} waits for #${other.item_id} (${other.item_owner}) on ${files.join(', ')}`] : [];
    });
}
