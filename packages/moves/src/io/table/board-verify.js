/** The verify table wired to the board's own reasons, cause keys, bar readers and strong-notice engine, so callers and replays share one source [C7,#8248]. */
import { pipelineCause } from '../../../../kernel/index.js';
import { STRONG_REJECTION_NOTICE_ENGINE } from '../../../../state/light.js';
import { ACCEPT_REASON } from '../../../../store/index.js';
import { REJECT_REASONS } from '../../../../store/index.js';
import { causeProblem } from '../../../../store/index.js';
import { frozenBar } from '../../../../verify/browser.js';
import { namedClause } from '../../../../verify/browser.js';
import { wording } from '../../../../verify/browser.js';
import { verifyEngine } from '../../logic/table/verify.table.js';

/**
 * The verify rules and table over the store's verdict reasons and cause rule, the verify package's bar readers and the kernel's cause classifier.
 * Why: the pure table takes all of them by injection; this is the one place that hands it the live ones.
 * The table reads a clause from the bar including its check, as the current engine does.
 *
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function boardVerifyEngine() {
  return verifyEngine({ acceptReason: ACCEPT_REASON, rejectReasons: REJECT_REASONS, wording, causeProblem, pipelineCause,
    frozenBar: (frozenText) => frozenBar({ item_frozen: frozenText }), namedClause: (bar, quote) => namedClause(bar, quote, true),
    strongNoticeEngine: STRONG_REJECTION_NOTICE_ENGINE });
}
