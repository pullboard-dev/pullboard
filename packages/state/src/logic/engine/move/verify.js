import { lineSettings } from '../../settings.js';
import { Refused } from '../../../../../kernel/light.js';

/** An outside sandbox verdict carries its bound outside receipt [H16]. */
export function prepareAfter(board, values, { ports }) {
  if (values[1]?.sandbox !== undefined) ports.requireOutsideReceipt(board, values[1].sandbox);
}

/** Replay a verdict with the move's implied-fact ids and the verify policy frozen on the item [V4,H16]. */
export function replayArgs(board, args, { move, store }) {
  // Implied facts take their ids from the sealed move, so every replica writes the same ones.
  if (args[1] && typeof args[1] === 'object' && !Array.isArray(args[1])) args[1].impliesId = move.id;
  const item = store.getItem(board, args[0]);
  const options = args[1];
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); }
  catch { throw new Refused('NO_POLICY', 'the frozen verify policy is invalid; ask the coordinator to refreeze this item before verifying it'); }
  const capturedPolicy = frozen?.policy;
  const captured = capturedPolicy?.verify;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      capturedPolicy?.version !== 1 || !/^[0-9a-f]{40,64}$/.test(capturedPolicy.commit ?? '') ||
      !['any', 'coordinator'].includes(captured?.policy) || !['off', 'prefer', 'require'].includes(captured?.family)) {
    throw new Refused('NO_POLICY', 'the frozen verify policy is missing or invalid; ask the coordinator to refreeze this item before verifying it');
  }
  args[1] = { ...options, policy: captured.policy, familyPolicy: captured.family, impliesId: move.id };
}

/** Seal automatic rejection routing before assigning the move's historical execution floor [B35,H16]. */
export function prepareBefore(board, values) {
  if (lineSettings(board).returnRejectedWork === true) values[1] = { ...values[1], returnRejectedWork: true };
}
