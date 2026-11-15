/** The submit tables wired to the store's own retry limit and infrastructure codes, so callers and replays share one source [C7,#8247]. */
import { INFRASTRUCTURE_CODES } from '../../../../store/index.js';
import { INFRASTRUCTURE_RETRY_LIMIT } from '../../../../store/index.js';
import { submitEngine } from '../../logic/table/submit.table.js';

/**
 * The submit rules and tables over the store's `INFRASTRUCTURE_RETRY_LIMIT` and `INFRASTRUCTURE_CODES`.
 * Why: the pure tables take both by injection; this is the one place that hands them the live ones.
 *
 * @returns {{ rules: Readonly<Record<string, object>>, tables: Readonly<Record<string, object>> }}
 */
export function boardSubmitEngine() {
  return submitEngine({ retryLimit: INFRASTRUCTURE_RETRY_LIMIT, infrastructureCodes: INFRASTRUCTURE_CODES });
}
