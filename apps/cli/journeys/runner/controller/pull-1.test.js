/** @pullboard-test-input source-tree */
/** 1 pulled runner job return the controller path's result and leave no controller process while waiting [C7,#5465]. */
import { definePullJourney } from '../../../tests/fixtures/runner/pull-journey.js';

definePullJourney(1);
