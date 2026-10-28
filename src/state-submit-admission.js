/** A native proof can finish its admitted claim; it never grants new work after expiry [V4,H16]. */
import { Refused } from './refused.js';
import { SUBMIT_ADMISSION_ENGINE } from './submit-admission-engine.js';

/** Validate an admission while its ordinary claim is still live, before recording the renewal. */
export function submitAdmission(board, itemId, actor, value) {
  if (value === null || value === undefined) return null;
  if (!/^[a-f0-9-]{36}$/u.test(value?.id ?? '')
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value?.commit ?? '')
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value?.tree ?? '')) {
    throw new Refused('USAGE', 'a submit admission names its native id and exact committed source');
  }
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(itemId);
  if (item?.item_status !== 'claimed' || item.item_owner !== actor || !(item.item_lease_until > board.clock.now().toISOString())) {
    throw new Refused('ITEM_LEASE_LOST', 'the submit admission needs the same live claim; claim the item before starting a new submit');
  }
  const used = board.db.prepare("SELECT 1 FROM event WHERE event_kind IN ('claim','renew') AND json_valid(event_detail) AND json_extract(event_detail,'$.submitAdmission.id')=? LIMIT 1").get(value.id);
  if (used) throw new Refused('USAGE', 'a submit admission id is used once; start a new native admission instead of reusing an old proof');
  return { id: value.id, commit: value.commit, tree: value.tree };
}

/** Only a matching final native proof recorded after the latest claim can finish expired work. */
export function completesAdmittedSubmit(board, move, item, actor) {
  if (move.engine < SUBMIT_ADMISSION_ENGINE || move.operation !== 'submit'
    || item.item_status !== 'claimed' || item.item_owner !== actor) return false;
  const claim = board.db.prepare("SELECT * FROM event WHERE event_by=? AND event_kind IN ('claim','renew') ORDER BY event_id DESC LIMIT 1").get(actor);
  if (claim?.item_id !== item.item_id) return false;
  const detail = JSON.parse(claim.event_detail);
  const admission = detail.submitAdmission;
  const source = move.args[1];
  if (!admission || admission.commit !== source?.commit || admission.tree !== source?.tree
    || detail.digest !== item.item_frozen_digest) return false;
  const receipts = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_by=? AND event_kind='proof-run' AND event_id>? ORDER BY event_id")
    .all(item.item_id, actor, claim.event_id).map(row => JSON.parse(row.event_detail).receipt)
    .filter(receipt => receipt?.submitAdmission === admission.id);
  return receipts.length > 0 && receipts.every(receipt => receipt.kind === 'submit' && receipt.item === item.item_id
    && receipt.seat === actor && receipt.commit === admission.commit && receipt.tree === admission.tree
    && receipt.frozenDigest === item.item_frozen_digest && receipt.sourceClean === true && Number.isSafeInteger(receipt.exitCode));
}
