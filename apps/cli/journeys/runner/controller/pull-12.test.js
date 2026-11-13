/** @pullboard-test-input source-tree */
/** 12 pulled runner jobs return the controller path's result and leave no controller process while waiting [C7,#5465]. */
import { definePullJourney } from '../../../tests/fixtures/runner/pull-journey.js';

definePullJourney(12);
