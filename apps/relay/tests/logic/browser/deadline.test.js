/** Browser reads have finite deadlines even when the underlying API ignores cancellation [H5,H16,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BROWSER_IO_TIMEOUT_MS } from '../../../index.js';
import { browserJSON } from '../../../index.js';
import { withBrowserDeadline } from '../../../index.js';

test('a browser operation that ignores cancellation still ends at its deadline [H5,H16]', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let owned;
  const read = withBrowserDeadline(signal => { owned = signal; return new Promise(() => {}); });
  const rejected = assert.rejects(read, error => error.code === 'RELAY_UNAVAILABLE' && /again/u.test(error.message));
  await nextTurn();
  assert.equal(owned.aborted, false);
  t.mock.timers.tick(BROWSER_IO_TIMEOUT_MS);
  await rejected;
  assert.equal(owned.aborted, true, 'cooperative APIs receive cancellation too');
});

test('a browser response whose JSON body never arrives keeps the same read deadline [H5,H16]', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let bodyStarted = false;
  let owned;
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    owned = options.signal;
    return { status: 200, json: () => { bodyStarted = true; return new Promise(() => {}); } };
  });
  const read = browserJSON('/fixture');
  const rejected = assert.rejects(read, error => error.code === 'RELAY_UNAVAILABLE');
  await nextTurn();
  assert.equal(bodyStarted, true, 'headers alone do not complete the read');
  t.mock.timers.tick(BROWSER_IO_TIMEOUT_MS);
  await rejected;
  assert.equal(owned.aborted, true);
});

test('completed browser reads remove their deadline and parent cancellation listener [H5,H16]', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  let owned;
  assert.equal(await withBrowserDeadline(signal => { owned = signal; return 'ready'; }, { signal: parent.signal }), 'ready');
  parent.abort(new Error('later unrelated cancellation'));
  t.mock.timers.tick(BROWSER_IO_TIMEOUT_MS);
  assert.equal(owned.aborted, false, 'neither a stale timer nor a detached parent can cancel completed work');
});

test('a browser read preserves an earlier parent cancellation reason [H5,H16]', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const reason = new Error('fixture parent stopped');
  let owned;
  const read = withBrowserDeadline(signal => { owned = signal; return new Promise(() => {}); }, { signal: parent.signal });
  const rejected = assert.rejects(read, error => error === reason);
  await nextTurn();
  parent.abort(reason);
  await rejected;
  assert.equal(owned.aborted, true);
  assert.equal(owned.reason, reason);
});
