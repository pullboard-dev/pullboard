/** Keep sealed person intent inside the CLI request boundary [H12,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveArgs } from '../src/api-moves.js';
import { personRequestMove, preparePersonRequest, validatePersonRequest } from '../src/person-request.js';
import { Refused } from '../src/refused.js';

test('[H12,H16] each supported person intent becomes literal CLI arguments', () => {
  const cases = [
    [{ verb: 'add', args: { lane: 'app', title: 'A title' } }, ['add', '--json', '--', 'app', 'A title']],
    [{ verb: 'shout', args: { to: 'coordinator', text: 'Please review' } }, ['shout', '--json', '--', 'coordinator', 'Please review']],
    [{ verb: 'answer', item: 7, args: { text: 'done' } }, ['answer', '7', '--as=person', '--json', '--', 'done']],
    [{ verb: 'hold', args: { lane: 'app', reason: 'Waiting for review' } }, ['hold', '--reason=Waiting for review', '--json', '--', 'app']],
    [{ verb: 'spec-approve', args: { ids: 'A4', by: 'person', text: 'Looks good' } }, ['spec', 'approve', '--by=person', '--text=Looks good', '--json', '--', 'A4']],
    [{ verb: 'spec-decline', args: { ids: 'A4', reason: 'Needs evidence' } }, ['spec', 'decline', '--reason=Needs evidence', '--json', '--', 'A4']],
  ];

  for (const [intent, expected] of cases) {
    assert.deepEqual(moveArgs(personRequestMove(intent)), expected, intent.verb);
  }
});

test('[H12,H16] person intent preserves literal leading-dash values and forces person answers', () => {
  const add = personRequestMove({ verb: 'add', args: { lane: 'app', title: '--looks-like-a-flag' } });
  assert.deepEqual(moveArgs(add), ['add', '--json', '--', 'app', '--looks-like-a-flag']);

  const shout = personRequestMove({ verb: 'shout', args: { text: '--not-a-recipient' } });
  assert.deepEqual(moveArgs(shout), ['shout', '--json', '--', '--not-a-recipient']);

  const answer = personRequestMove({ verb: 'answer', item: 9, args: { text: 'done' } });
  assert.equal(answer.args.as, 'person');
  assert.deepEqual(moveArgs(answer), ['answer', '9', '--as=person', '--json', '--', 'done']);
});

test('[H12,H16] request documents reject engine operations, impersonation and malformed arguments', () => {
  const refused = (call, code = 'BAD_REQUEST') => {
    assert.throws(call, error => error instanceof Refused && error.code === code);
  };

  refused(() => personRequestMove({ verb: 'claim', item: 1, args: {} }));
  refused(() => personRequestMove({ verb: 'answer', item: 1, agent: 'remote-1', args: { text: 'done' } }));
  refused(() => personRequestMove({ verb: 'answer', item: 1, args: { text: 'done', as: 'coordinator' } }), 'B26_PERSON_ANSWER');
  refused(() => personRequestMove({ verb: 'add', args: { lane: 'app', title: 'A title', mystery: true } }));
  refused(() => personRequestMove({ verb: 'add', args: ['app', 'A title'] }));
  refused(() => personRequestMove({ operation: 'verify', args: [1, {}] }));
});

test('[H12,H16] versioned person requests reject newer formats and unstable identifiers', () => {
  const request = preparePersonRequest({ verb: 'add', args: { lane: 'app', title: 'A title' } }, 'browser_req-1');
  assert.deepEqual(request, {
    version: 1,
    type: 'person-request',
    id: 'browser_req-1',
    move: { verb: 'add', args: { lane: 'app', title: 'A title' } },
  });
  assert.deepEqual(validatePersonRequest(request), request);

  assert.throws(() => validatePersonRequest({ ...request, version: 2 }), error => error instanceof Refused && error.code === 'PERSON_REQUEST_VERSION');
  for (const id of ['', '../request', 'request id', 'x'.repeat(81)]) {
    assert.throws(() => validatePersonRequest({ ...request, id }), error => error instanceof Refused && error.code === 'BAD_REQUEST');
  }
  assert.throws(() => validatePersonRequest({ ...request, unexpected: true }), error => error instanceof Refused && error.code === 'BAD_REQUEST');
});
