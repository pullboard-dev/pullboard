/** A burst of file changes wakes a file waiter once, not once per change, and a later change wakes it again [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileChangeWaiter } from '../../index.js';

/** A native watch that hands its callbacks to the test, and a timer the test fires by hand. */
function fakeKit() {
  const callbacks = [], scheduled = [];
  const watch = (target, ...rest) => {
    const callback = rest.at(-1);
    callbacks.push(callback);
    return { on() {}, close() {} };
  };
  const schedule = (run) => { const handle = { run }; scheduled.push(handle); return handle; };
  const cancel = (handle) => { handle.cancelled = true; };
  return { watch, schedule, cancel, callbacks, scheduled };
}

test('file-watch callbacks are coalesced: a burst of changes runs one refresh, not one per file [C7]', t => {
  const kit = fakeKit();
  const name = `nonexistent-${process.pid}`;
  const inputs = Array.from({ length: 20 }, (_, index) => `/${name}/input-${index}`);
  const waiter = fileChangeWaiter(inputs, kit);
  t.after(() => waiter.close());
  assert.ok(kit.callbacks.length > 0, 'the waiter binds native watchers');
  const before = waiter.version();
  for (let round = 0; round < 50; round += 1) for (const callback of kit.callbacks) callback('change', name);
  assert.equal(kit.scheduled.length, 1, `${50 * kit.callbacks.length} native events scheduled ${kit.scheduled.length} passes`);
  assert.equal(waiter.version(), before, 'nothing refreshes until the window ends');
  kit.scheduled[0].run();
  assert.equal(waiter.version(), before + 1, 'the whole burst wakes the waiter once');
  for (const callback of kit.callbacks) callback('change', name);
  assert.equal(kit.scheduled.length, 2, 'the next change after the window opens a new pass');
  kit.scheduled[1].run();
  assert.equal(waiter.version(), before + 2);
});

test('closing a waiter cancels its pending pass [C7]', () => {
  const kit = fakeKit();
  const name = `nonexistent-${process.pid}`;
  const waiter = fileChangeWaiter([`/${name}/input`], kit);
  for (const callback of kit.callbacks) callback('change', name);
  assert.equal(kit.scheduled.length, 1);
  waiter.close();
  assert.equal(kit.scheduled[0].cancelled, true);
  kit.scheduled[0].run();
  assert.equal(waiter.version(), 0, 'a closed waiter never wakes');
});
