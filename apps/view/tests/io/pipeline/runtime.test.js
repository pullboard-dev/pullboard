/** The Pipeline page's runtime: it reads the held history and this machine, draws once, and keeps a group open across a redraw [N26,#6869]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipelineRuntime } from '../../../src/io/pipeline/runtime.js';

/** A stand-in pane that records what is painted and the listeners it is given. */
function pane() {
  const listeners = new Map();
  return { innerHTML: '', addEventListener: (type, handler) => listeners.set(type, handler), listeners, contains: () => true };
}

test('clause 2: it draws "reading" until the history is complete, then draws the model and refreshes the machine only every ten seconds [N26,#6869]', async t => {
  const region = pane(), previous = globalThis.document;
  globalThis.document = { getElementById: id => id === 'insights-pipeline' ? region : null };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  let complete = false, usable = false, redraws = 0, now = 1_000_000;
  const reads = [], models = [], opened = [];
  const real = Date.now; Date.now = () => now; t.after(() => { Date.now = real; });
  const runtime = pipelineRuntime({
    model: (project, events, options) => { models.push({ events, options }); return { windowMinutes: options.windowMinutes, machine: options.machine }; },
    html: (state, options) => '<b>' + state.windowMinutes + '|' + (state.machine?.cores ?? 'none') + '|' + (options.open ?? ['default']).join(',') + '</b>',
    history: () => ({ events: [{ event_id: 1 }], complete, usable, version: 1, error: null }),
    api: async path => { reads.push(path); return { machine: { cores: 12 } }; }, current: () => '/board', redraw: () => { redraws++; },
    windowMinutes: () => 180, itemsHref: () => '#', itemHref: () => '#', openItems: ids => opened.push(ids), machineHere: true,
  });
  const project = { root: '/board', sequence: 1, observedAt: '2026-11-13T12:00:00Z' };
  runtime.draw(project);
  assert.match(region.innerHTML, /Reading the board.s event history/u, 'an incomplete history draws nothing it could miscount');
  assert.equal(models.length, 0, 'the model is not worked out from a partial history');
  assert.deepEqual(reads, ['/api/v1/machine'], 'this machine is read once the page opens');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(redraws, 1, 'the page draws again when the samples arrive');
  complete = true;
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
  complete = false; usable = true;
  runtime.draw({ ...project, sequence: 9, observedAt: '2026-11-13T12:05:00Z' });
  assert.equal(region.innerHTML, '<b>180|12|released,blocked</b>', 'a history that was complete and is a few events behind still draws, so a busy board never flickers back to Reading');
  usable = false;
  runtime.draw({ ...project, sequence: 10, observedAt: '2026-11-13T12:06:00Z' });
  assert.match(region.innerHTML, /Reading the board.s event history/u, 'a history never completed still says so');
});
