/** @pullboard-test-input source-tree */
/** Twelve pulled runner jobs leave no controller process while they wait, in a file of their own so a loaded runner stays inside the file limit [C7,#5465,#5537,#6734]. */
import { definePullJourney } from '../../../fixtures/runner/pull-journey.js';

definePullJourney(12);
