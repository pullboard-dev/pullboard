import { refuseManualCheckBaseline } from '../../../../../packages/verify/index.js';

/**
 * Public command entry: refuse a hand-taken check baseline, since baselines are taken automatically [B35,V2,C7].
 * Baseline policy lives behind the verify front door; this module only declares the command's run.
 */
export function run(...args) { return refuseManualCheckBaseline(...args); }
