/** The Pipeline page's runtime: it reads the held history and this machine, draws once, and keeps a group open across a redraw [N26,#6869]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipelineRuntime } from '../../../src/io/pipeline/runtime.js';

/** Let every promise the stub api has queued settle: the stubs answer in microtasks, so no clock is involved. */
async function flush() { for (let turn = 0; turn < 200; turn++) await Promise.resolve(); }

/** A stand-in pane that records what is painted and the listeners it is given. */
function pane() {
  const listeners = new Map();
  return { innerHTML: '', addEventListener: (type, handler) => listeners.set(type, handler), listeners, contains: () => true };
}

test('view.x-io-pipeline-runtime.clause-2-it-draws-reading-until-the: clause 2: it draws "reading" until the history is complete, then draws the model and refreshes the machine only every ten seconds [N26,#6869]', async t => {
  const region = pane(), previous = globalThis.document;
  globalThis.document = { getElementById: id => id === 'insights-pipeline' ? region : null };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  let release, redraws = 0, now = 1_000_000;
  const gate = new Promise(resolve => { release = resolve; }), reads = [], models = [], opened = [];
  const real = Date.now; Date.now = () => now; t.after(() => { Date.now = real; });
  const runtime = pipelineRuntime({
    model: (project, events, options) => { models.push({ events, options }); return { windowMinutes: options.windowMinutes, machine: options.machine }; },
    html: (state, options) => '<b>' + state.windowMinutes + '|' + (state.machine?.cores ?? 'none') + '|' + (options.open ?? ['default']).join(',') + '</b>',
    boardPath: () => '/api/v1/boards/b',
    api: async path => { if (path.includes('/events')) { await gate; return { events: [] }; } reads.push(path); return { machine: { cores: 12 } }; }, current: () => '/board', redraw: () => { redraws++; },
    windowMinutes: () => 180, itemsHref: () => '#', itemHref: () => '#', openItems: ids => opened.push(ids), machineHere: true,
  });
  const project = { root: '/board', sequence: 1, observedAt: '2026-11-13T12:00:00Z' };
  runtime.draw(project);
  assert.match(region.innerHTML, /Reading the board.s event history/u, 'an incomplete history draws nothing it could miscount');
  assert.equal(models.length, 0, 'the model is not worked out from a partial history');
  assert.deepEqual(reads, ['/api/v1/machine'], 'this machine is read once the page opens');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(redraws, 1, 'the page draws again when the samples arrive');
  release(); await flush();
  runtime.draw(project);
  assert.equal(region.innerHTML, '<b>180|12|default</b>', 'the model gets the window and the samples, and the markup is what it returns');
  assert.equal(models.at(-1).options.windowMinutes, 180);
  assert.equal(models.at(-1).options.now, Date.parse(project.observedAt), 'the API observation clock governs the windows');
  runtime.draw(project);
  assert.equal(models.length, 1, 'the same state draws from the kept model');
  assert.equal(reads.length, 1, 'the machine is not read again inside ten seconds');
  now += 11_000;
  runtime.draw(project);
  assert.equal(reads.length, 2, 'and is read again after ten');

  // The group toggle and the counts' links, through the pane's one handler.
  const click = region.listeners.get('click');
  const group = { classList: { contains: () => false, toggle() {} }, dataset: { pipelineGroup: 'blocked' }, parentElement: { querySelectorAll: () => [{ dataset: { pipelineGroup: 'released' } }] } };
  const head = { parentElement: group, setAttribute() {} };
  click({ target: { closest: selector => selector === '.pw-gh' ? head : selector === 'a' ? null : null }, metaKey: false });
  runtime.draw({ ...project, observedAt: '2026-11-13T12:00:01Z' });
  assert.equal(region.innerHTML, '<b>180|12|released,blocked</b>', 'the groups open when the person pressed one stay open across a redraw');
  let prevented = false;
  click({ target: { closest: selector => selector === 'a[data-pipeline-ids]' ? { dataset: { pipelineIds: '6579,6580' } } : null }, metaKey: false, button: 0, preventDefault() { prevented = true; } });
  assert.deepEqual(opened, [[6579, 6580]], 'a count opens Items on its ids');
  assert.equal(prevented, true);
  runtime.draw({ ...project, sequence: 9, observedAt: '2026-11-13T12:05:00Z' });
  assert.equal(region.innerHTML, '<b>180|12|released,blocked</b>', 'a history that was complete and is a few events behind still draws, so a busy board never flickers back to Reading');
  runtime.draw({ ...project, root: '/never-read', sequence: 10, observedAt: '2026-11-13T12:06:00Z' });
  assert.match(region.innerHTML, /Reading the board.s event history/u, 'a history never completed still says so');
});

/** A stub board of `count` events, one every ten minutes, ending at `end`; its api records every events request and answers like the real route. */
function board(count, end, { batch = 50_000 } = {}) {
  const log = [], at = id => new Date(end - (count - id) * 600_000).toISOString();
  const api = async path => {
    log.push(path);
    const query = new URLSearchParams(path.split('?')[1]), after = Number(query.get('after')), limit = Number(query.get('limit'));
    const events = [];
    for (let id = after + 1; id <= count && events.length < limit; id++) events.push({ event_id: id, event_at: at(id) });
    return { events };
  };
  return { api, log, at, batch };
}

/** Run the runtime over a stub board until its read settles, returning what the model was handed. */
async function readWindow(t, stub, project) {
  const region = pane(), previous = globalThis.document;
  globalThis.document = { getElementById: id => id === 'insights-pipeline' ? region : null };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const models = [];
  const runtime = pipelineRuntime({
    model: (_project, events) => { models.push(events); return {}; }, html: () => '<b>drawn</b>', boardPath: () => '/api/v1/boards/b', api: stub.api,
    current: () => project.root, redraw: () => runtime.draw(project), windowMinutes: () => 180, itemsHref: () => '#', itemHref: () => '#', openItems() {}, machineHere: false,
  });
  runtime.draw(project);
  assert.match(region.innerHTML, /Reading the board.s event history/u, 'it says so until the window is read');
  await flush();
  return { models, region, runtime };
}

test('view.pipeline.window-read: clause 1: a board with more events than the window reads only the events inside the 26-hour floor and never after=0 [N26]', async t => {
  // 20,000 events at ten-minute spacing run back 138 days; the 26 hours before the end hold 157 of them.
  const end = Date.parse('2026-11-20T01:00:00Z'), stub = board(20_000, end);
  const project = { root: '/board', sequence: 20_000, observedAt: new Date(end).toISOString() };
  const { models, region } = await readWindow(t, stub, project);
  assert.equal(region.innerHTML, '<b>drawn</b>');
  const events = models.at(-1), floor = end - 26 * 3_600_000;
  assert.ok(events.length > 100 && events.length < 200, 'the model gets about 26 hours of events, got ' + events.length);
  assert.ok(events.every(event => Date.parse(event.event_at) >= floor), 'no event older than the floor is read into the model');
  assert.equal(events.at(-1).event_id, 20_000, 'it reads through the newest event');
  assert.ok(!stub.log.some(path => path.includes('after=0&')), 'it never reads from the start of the history: ' + stub.log.join(' '));
  assert.ok(stub.log.every(path => path.includes('&limit=')), 'every read names a limit');
  assert.ok(stub.log.length < 40, 'finding the floor takes about twenty one-event probes, not a scan: ' + stub.log.length);
});

test('view.pipeline.window-live: clause 2: the page reads through its own window, keeps drawing a few events behind, and a later read appends only events after the last held id [N26]', async t => {
  const end = Date.parse('2026-11-20T01:00:00Z'), stub = board(2_000, end);
  const project = { root: '/board', sequence: 2_000, observedAt: new Date(end).toISOString() };
  const { models, region, runtime } = await readWindow(t, stub, project);
  const reads = stub.log.length;
  const first = models.at(-1).length;
  runtime.draw({ ...project, sequence: 2_000 });
  assert.equal(stub.log.length, reads, 'the same prefix is not read again');
  // The board moves on by one event: the page still draws at once, and the read after it starts at the last held id.
  const moved = { ...project, sequence: 2_001 };
  runtime.draw(moved);
  assert.equal(region.innerHTML, '<b>drawn</b>', 'a window that was complete once keeps drawing while the next events arrive');
  await flush();
  assert.equal(stub.log.at(-1), '/api/v1/boards/b/events?after=2000&limit=50000', 'a later read starts after the last held id, not from the start of the window');
  assert.ok(first > 100, 'the first read held the window');
});
