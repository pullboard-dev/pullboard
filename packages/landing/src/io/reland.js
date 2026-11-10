/** Before selection, landing returns accepted work a batch-wide red sent back to open [B3,C7]. */
import { landingWaiverFor } from '../logic/waivers.js';
import * as store from '../../../store/index.js';
import { tryGit } from '../../../git/index.js';

/**
 * Git's conflicting paths for `head` merged onto `base`: [] when clean, null when Git cannot tell.
 *
 * @param {string} root
 * @param {string} base
 * @param {string} head
 * @returns {string[] | null}
 */
function relandConflicts(root, base, head) {
  const merged = tryGit(root, ['-c', 'core.quotepath=false', 'merge-tree', '--write-tree', '--name-only', '-z', base, head]);
  const output = (merged.stdout ?? '').split('\0');
  if (![0, 1].includes(merged.status) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(output[0].trim())) return null;
  if (merged.status === 0) return [];
  const records = output.slice(1), end = records.indexOf('');
  const files = [...new Set(records.slice(0, end < 0 ? records.length : end))].sort();
  return files.length ? files : null;
}

/**
 * Write one relandAccepted move per open item whose landing reopen left its own accept and green gate intact.
 * Why: a landing-failure reopen kept the accept but needed a new build and review before the item could land again.
 * A recorded culprit whose tests are not waived stays open, as selection would refuse it LAND_KNOWN_RED.
 *
 * @param {{ root: string, board: any, base: string, write: Function, say?: Function, landingPorts?: any }} options
 * @returns {Promise<object[]>} each move's result
 */
export async function relandAcceptedItems({ root, board, base, write, say = () => {}, landingPorts }) {
  const culprits = store.landingBatches(board).flatMap(batch => batch.culprits ?? []);
  const results = [];
  for (const item of store.listItems(board, { all: true })) {
    if (item.item_status !== 'open') continue;
    const candidate = store.acceptedRelandCandidate(board, item);
    if (!candidate) continue;
    const known = culprits.find(entry => entry.id === item.item_id && entry.commit === item.item_commit);
    if (known && !(known.tests ?? []).every(failure => landingWaiverFor(board, failure, landingPorts))) continue;
    const conflicts = relandConflicts(root, base, candidate.accept.review?.head ?? item.item_commit);
    if (conflicts === null || conflicts.length && store.relandConflictRecorded(board, item, conflicts)) continue;
    const result = await write('relandAccepted', [item.item_id, { agentId: 'coordinator', main: base, conflicts }]);
    say(conflicts.length ? `landing leaves #${item.item_id} open: conflicts with main in ${conflicts.join(', ')}`
      : `landing returns #${item.item_id} to verified on its accept ${candidate.accept.verdict_id}`);
    results.push(result);
  }
  return results;
}
