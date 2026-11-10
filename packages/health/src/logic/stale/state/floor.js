/** A pending modern condition cannot be skipped by an older ordered writer [B4,H16]. */
import { STALE_STATE_ENGINE } from '../../../../../state/light.js';

/** Preserve all historical prefixes, raising the floor only while a versioned condition exists. */
export function conditionalHoldFloor(board) {
  return board?.db.prepare("SELECT 1 FROM board_meta WHERE meta_key GLOB 'stale_hold_until:*' LIMIT 1").get() ? STALE_STATE_ENGINE : 1;
}
