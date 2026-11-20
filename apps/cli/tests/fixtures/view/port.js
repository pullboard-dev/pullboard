/** The view port fixture lives with the gate tests; app tests reach it through this door [N26,C7]. */
import { chooseViewPort } from '../../../../../packages/gate/tests/fixtures/view-port.js';
export * from '../../../../../packages/gate/tests/fixtures/view-port.js';
export const VIEW_PORT_CHOOSER = chooseViewPort;
