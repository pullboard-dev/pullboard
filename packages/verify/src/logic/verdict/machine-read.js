import { createHash } from 'node:crypto';

/** Bind a machine authorization to the exact acceptance bar without loading its writer guards. */
export function machineBarDigest(item) {
  return createHash('sha256').update(JSON.stringify([item.item_criterion, item.item_check, item.item_spec_ids, item.item_brief])).digest('hex');
}
