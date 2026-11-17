/** The SELF_SESSION_VERIFY refusal names starting the review in a separate process or session [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refused } from '../../../../../kernel/index.js';
import { refuseSelfSession } from '../../../../../items/index.js';
import { verify } from '../../../../index.js';

/** Collect the registered hint for the code from the verify move's declaration. */
function registeredHint() {
  return JSON.stringify(verify);
}

test('moves.record-next-idle-verify.the-self-session-verify-next-step-says-to-start: clause 1: [C7] the SELF_SESSION_VERIFY next step says to start the review in a separate process or session', () => {
  let refusal;
  try {
    refuseSelfSession({ commonDir: '/nonexistent' }, { item_id: 1, item_built_by: 'a' }, 'digest', [], { currentAuthorSessions: ['digest'] });
  } catch (error) { refusal = error; }
  assert.ok(refusal instanceof Refused || refusal?.code === 'SELF_SESSION_VERIFY', String(refusal));
  assert.equal(refusal.code, 'SELF_SESSION_VERIFY');
  assert.match(refusal.next, /start the review in a separate process or session/);
  assert.match(refusal.next, /pullboard next --verify/);
  assert.match(registeredHint(), /start the review in a separate process or session/);
});
