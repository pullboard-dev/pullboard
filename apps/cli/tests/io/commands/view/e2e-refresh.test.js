import { cliCockpitRenderer$cockpitPage as cockpitSource } from '../../../../index.js';
/** The view's refresh re-renders only what changed, in its own file so the census runs it apart [N26,A2]. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

test('cli.journeys-view-e2e-refresh.the-view-s-refresh-re-renders: the view\'s refresh re-renders only what changed [N26,A2]', async () => {
  const page = cockpitSource();
  const start = page.indexOf('async function refresh(');
  const end = page.indexOf('\n// The local view follows', start);
  assert.ok(start >= 0 && end > start, 'find the production refresh function');
  const refresh = page.slice(start, end);
  const hasDeferredDetail = page.includes('const itemSearches = new Map();');
  const hasBoardModeSync = page.includes('function syncBoardMode(');
  const calls = [];
  const events = [];
  const context = {
    addressReady: true,
    address: () => {},
    api: async () => ({ events: [] }),
    boardPath: () => '/board',
    // refresh() calls these helpers, defined outside the slice this test runs (#644's clock-blind board text and
    // in-place ages, #633's share invitation, #900's render handshake); the page's own behavior is covered elsewhere.
    boardText: (state) => JSON.stringify(state),
    showFlowAges: () => {},
    tickAges: () => {},
    sharingReady: null,
    sharingInvitation: () => Promise.resolve(),
    transport: null,
    // The page's board store is outside the slice this test runs; set() hands back the state it was given.
    store: { set: (next) => next },
    warmTabs: () => {},
    boardState: () => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      calls.push({ promise, resolve });
      return promise;
    },
    catchEvery: false,
    catchUp: () => {},
    data: { projects: [] },
    detailRead: null,
    follow: () => {},
    keep: () => 'unchanged',
    loadAddressedShout: async () => {},
    liveLine: () => 'live',
    placeAtAddress: () => null,
    refreshDrawn: { generation: 0, full: false },
    refreshStarted: 0,
    render: () => {
      events.push(['render', context.data.project.items[0]?.title]);
      if (hasDeferredDetail) {
        context.__nextDetail = (() => {
          let resolve;
          const promise = new Promise((done) => { resolve = done; });
          return { promise, resolve };
        })();
        context.__setDetailRead(context.__nextDetail.promise);
      }
    },
    replayControls: () => {},
    seen: 'before-first-read',
    snapshot: true,
    snapshotReplay: { final: {} },
    syncBoardMode: () => events.push(['sync', context.data.project.items[0]?.title]),
    view: { root: '/fixture', seen: { 'pb.seen./fixture': 'seen-at-start' } },
    $: () => ({ textContent: '' }),
  };
  if (hasDeferredDetail) {
    context.itemSearches = new Map([['old-query', ['stale-result']]]);
    context.__nextDetail = (() => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      return { promise, resolve };
    })();
    context.__setDetailRead = (value) => { context.detailRead = value; };
  }
  vm.runInNewContext(`\n${refresh}\n`, context, { filename: 'cockpit-refresh.js' });

  const next = (marker) => ({
    projects: [{ ok: true, root: '/fixture' }],
    project: { root: '/fixture', items: [{ id: 1, status: 'open', title: marker }] },
    group: null,
  });
  /** Resolve one controlled state read and verify refresh completion against its render barrier. */
  async function applyRead(marker) {
    const renderCount = events.filter(([kind]) => kind === 'render').length;
    if (hasDeferredDetail) context.itemSearches.set('query-under-pointer', ['stale-result']);
    const pending = vm.runInNewContext('refresh(true)', context);
    let completed = false;
    let failure;
    const observed = pending.then(
      () => { completed = true; },
      (error) => { completed = true; failure = error; },
    );
    const call = calls.at(-1);
    assert.ok(call, 'refresh starts a board state read');
    call.resolve(next(marker));
    await new Promise((resolve) => setImmediate(resolve));
    // A helper refresh() calls but this slice does not stub fails here by name, not as a later count.
    if (failure) throw failure;
    const renderedThisRead = events.filter(([kind]) => kind === 'render').length > renderCount;
    if (hasDeferredDetail && renderedThisRead) {
      assert.equal(context.itemSearches.size, 0, 'changed board invalidates deferred item search results');
      assert.equal(completed, false, 'refresh waits for item detail started by the changed-board render');
      context.__nextDetail.resolve();
    } else if (hasDeferredDetail) {
      assert.equal(context.itemSearches.size, 1, 'an unchanged board leaves the active search alone');
      assert.equal(completed, true, 'an unchanged board completes without a detail follow-up');
    }
    await observed;
    if (failure) throw failure;
  }

  await applyRead('first');
  assert.deepEqual(events.filter(([kind]) => kind === 'render'), [['render', 'first']]);
  if (hasBoardModeSync) assert.deepEqual(events.slice(-2), [['sync', 'first'], ['render', 'first']]);

  await applyRead('first');
  assert.deepEqual(events.filter(([kind]) => kind === 'render'), [['render', 'first']], 'an unchanged board is not rebuilt');

  await applyRead('second');
  assert.deepEqual(events.filter(([kind]) => kind === 'render'), [['render', 'first'], ['render', 'second']]);
  if (hasBoardModeSync) assert.deepEqual(events.slice(-2), [['sync', 'second'], ['render', 'second']]);
});
