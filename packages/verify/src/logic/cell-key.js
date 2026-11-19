/** The verdict key of one pure cell: it changes only when a file of the cell or a contract the cell reaches changes [C7,R38,S10]. */
import { createHash } from 'node:crypto';

/**
 * The sha256 hex of the sorted file digests and reached contract keys of one cell.
 * Why: a stored verdict is reusable exactly while this key holds, so order and unrelated cells must not move it.
 *
 * @param {{ files?: Record<string, string>, contracts?: Record<string, string> }} input - Path to content digest, and contract name to its key.
 * @returns {string} The key.
 */
export function cellVerdictKey({ files = {}, contracts = {} } = {}) {
  const sorted = map => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ files: sorted(files), contracts: sorted(contracts) })).digest('hex');
}
