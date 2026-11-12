/** Pages reads relay routes, storage status, the first-screen snapshot and addressed shouts without any server-only code [C7,H5,H15,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURRENT_SNAPSHOT_BYTES } from '../../../index.js';
import { currentSnapshotPresentation } from '../../../index.js';
import { legacyPageRoute } from '../../../index.js';
import { presentationShout } from '../../../index.js';
import { relayStorage } from '../../../index.js';
import { relayStorageLine } from '../../../index.js';

test('only a recognized old route response is a legacy page route, never an auth or uncertain refusal [H15,H17]', () => {
  assert.equal(legacyPageRoute({ relayVersion: 1, httpStatus: 404 }), true);
  assert.equal(legacyPageRoute({ relayVersion: 1, httpStatus: 400, code: 'BAD_REQUEST' }), true);
  for (const error of [null, {}, { relayVersion: 1, httpStatus: 400, code: 'OTHER' }, { relayVersion: 1, httpStatus: 401 }, { relayVersion: 2, httpStatus: 404 }, { httpStatus: 404 }]) {
    assert.equal(legacyPageRoute(error), false, JSON.stringify(error));
  }
});

test('storage status keeps only validated credential-free fields, and its line reports megabytes [H15]', () => {
  const status = { account: { id: 'u_1', login: 'corey', token: 'secret' }, usedBytes: 2_500_000, limitBytes: 10_000_000, extra: true };
  assert.deepEqual(relayStorage(status), { account: { id: 'u_1', login: 'corey' }, usedBytes: 2_500_000, limitBytes: 10_000_000 });
  assert.equal(relayStorageLine(status), 'relay storage: account corey, 2.5 MB used of 10.0 MB');
  for (const bad of [null, {}, { ...status, account: { id: 'bad id', login: 'corey' } }, { ...status, account: { id: 'u_1' } }, { ...status, usedBytes: -1 }, { ...status, limitBytes: 0 }, { ...status, usedBytes: 1.5 }]) {
    assert.equal(relayStorage(bad), null);
    assert.equal(relayStorageLine(bad), '');
  }
});

test('an addressed shout resolves from a decoded snapshot, with its decision state, and refuses what the snapshot lacks [C7,H5]', () => {
  const shouts = [{ shout_id: 1, shout_decision: 1 }, { shout_id: 2, shout_answers: 1 }, { shout_id: 3, shout_decision: 1 }, { shout_id: 4 }];
  assert.deepEqual(presentationShout({ shouts }, 1), { shout_id: 1, shout_decision: 1, decision_state: 'answered', decision_answer: shouts[1] });
  assert.deepEqual(presentationShout({ shouts }, 3), { shout_id: 3, shout_decision: 1, decision_state: 'open', decision_answer: null });
  assert.deepEqual(presentationShout({ shouts }, 4), { shout_id: 4, decision_state: null, decision_answer: null });
  assert.throws(() => presentationShout({ shouts }, 9), error => error.code === 'NO_SHOUT');
  assert.throws(() => presentationShout({}, 1), error => error.code === 'SHOUT_NOT_AVAILABLE');
});

const item = (id, over = {}) => ({ id, title: `Item ${id}`, lane: 'core', criterion: 'long text', brief: 'brief', verdicts: [], history: [{ at: 1 }], thread: [], ...over });

test('the first screen drops item detail and shout history and keeps everything else when it already fits [H15,H17]', () => {
  const presentation = { version: 1, config: { name: 'board' }, shouts: [{ shout_id: 1 }], state: { items: [item(1), item(2)], milestones: ['m'] } };
  const first = currentSnapshotPresentation(presentation);
  assert.deepEqual(first.state.items, [{ id: 1, title: 'Item 1', lane: 'core' }, { id: 2, title: 'Item 2', lane: 'core' }]);
  assert.equal('shouts' in first, false);
  assert.deepEqual([first.config, first.state.milestones], [{ name: 'board' }, ['m']]);
  assert.equal(presentation.state.items[0].criterion, 'long text', 'the source is untouched');
});

test('an oversized presentation is cut to arrays and text that fit the first-screen limit, keeping its schema [H15,H17]', () => {
  const items = Array.from({ length: 6000 }, (_, id) => item(id, { notes: 'n'.repeat(300) }));
  const first = currentSnapshotPresentation({ version: 1, config: {}, state: { items, extra: 'e'.repeat(10_000) } });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= CURRENT_SNAPSHOT_BYTES);
  assert.ok(first.state.items.length > 0 && first.state.items.length < 6000);
  assert.equal(first.state.items[0].id, 0);
  assert.ok(first.state.extra.length < 10_000 && first.state.extra.endsWith('…'));
  assert.equal(first.version, 1);
});

test('a presentation without an item list is not a snapshot and is refused [H15]', () => {
  for (const bad of [null, {}, { state: {} }, { state: { items: 'no' } }]) {
    assert.throws(() => currentSnapshotPresentation(bad), error => error.code === 'RELAY_SNAPSHOT');
  }
});
