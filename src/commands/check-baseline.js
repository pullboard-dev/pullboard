/** Public command entry; baseline policy lives behind the verify front door [B35,V2,C7]. */
import { refuseManualCheckBaseline } from '../../packages/verify/index.js';

/** Refuse a manual baseline: the board records each check's baseline when the item is added. */
export function run() {
  return refuseManualCheckBaseline();
}
