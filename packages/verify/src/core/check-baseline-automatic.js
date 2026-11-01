import { Refused } from '../../../kernel/index.js';

/** Baseline observations belong to item creation, so a manual baseline cannot become a second workflow [B35,V2]. */
export function refuseManualCheckBaseline() {
  throw new Refused('CHECK_BASELINE_AUTOMATIC', 'the board baselines checks on add',
    'add the item with --check; its baseline is recorded against the current trunk automatically');
}
