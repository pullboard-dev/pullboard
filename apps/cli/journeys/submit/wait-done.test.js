/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';

import { waitKit } from '../../tests/fixtures/submit/wait.js';

const { helpers, waitingVerdict } = waitKit(store);
after(helpers.cleanup);

/** The historical alias retains the same versioned submission fields while returning its verdict. */
test('cli.journeys-submit-wait-done.done-wait-preserves-gate-json-independently: done --wait preserves gate JSON independently of the later accepted verdict [V2,A1]', async t => {
  await waitingVerdict(t, 'ACCEPT', { command: 'done', json: true });
});
