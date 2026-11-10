/** Acceptance owns mechanical landing; the existing engine retains batching, gates and rework [B35,B3,R3]. */
import { Refused } from '../../../kernel/index.js';
import { mechanicalConflictFiles } from './mechanical.js';

/** Only policy already accepted on trunk can grant a manual landing override. */
export function automaticLandingEnabled(config) {
  return config.landing?.manualOverride !== true;
}

/** Refuse a coordinator command while the board owns landing. */
export function requireManualLanding(config) {
  if (automaticLandingEnabled(config)) throw new Refused('BOARD_LANDS_ACCEPTED', 'the board lands accepted items', 'take other work with pullboard next; nothing for this seat: end your turn');
}

/** Return exact conflicting accepted heads before selecting the clean native batch. */
export async function landAcceptedItems({ root, config, trunk, items, reopen, execute }) {
  if (!automaticLandingEnabled(config)) return null;
  for (const item of items) {
    const files = mechanicalConflictFiles(root, trunk, item.commit);
    if (files === null) throw new Refused('LAND_MERGE', 'cannot inspect the accepted head; restore its Git objects so the board can land it');
    if (files.length) await reopen(item.id, { files, trunk });
  }
  // The landing engine returns only independently bisected culprits; a blocked batch is not evidence against its other items.
  return await execute();
}
