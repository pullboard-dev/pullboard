/** @pullboard-test-input source-tree */
/** Pulled runner jobs 1 and 12 leave no controller process while they wait [C7,#5465,#5537,#6734]. */
import { definePullJourney } from '../../fixtures/runner/pull-journey.js';

definePullJourney(1);
definePullJourney(12);
