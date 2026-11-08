/** The shared readers the runner's hand-off stages call: the same doctrine, cells, composition and failure code the local worker runs [C7]. */
import { requireSubmitCells } from '../../../../bin/cells-submit-checks.js';
import { holdDoctrineAsync } from '../../../../packages/doctrine/index.js';
import { ruleLine } from '../../../../packages/doctrine/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { failureSignatures } from '../../../../packages/landing/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { requireSubmitComposition } from '../../../../packages/items/index.js';
import { tapTests } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';

/**
 * The stage services for the runner's hand-off job. Why here: the runner app imports no other cell, so the job's entry
 * passes these in, as the local worker's submit passes them to its own stages.
 *
 * @returns {{ doctrine: object, cells: object, composition: object, failures: object }}
 */
export function handoffStageServices() {
  return {
    doctrine: { holdDoctrineAsync, ruleLine },
    cells: { requireSubmitCells, gate: { importsIn, commonJsIn, withImportParseCache, foreignNodeOptions }, landing: { withMainCheckout } },
    composition: { requireSubmitComposition },
    failures: { tapTests, failureSignatures },
  };
}
