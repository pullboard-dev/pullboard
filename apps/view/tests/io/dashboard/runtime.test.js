/** Runtime contract controls reject incomplete history; the neighboring HTTP/Chrome cases prove real transport [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardRuntime } from '../../../index.js';

/** Drain only the already queued read-promise callbacks, without a timer or absence assertion. */
async function delivered() { for (let index = 0; index < 6; index++) await Promise.resolve(); }

test('Dashboard refuses truncated history and isolates a replaced board at the same root [N26]', async t => {
  const previous = globalThis.document;
  const region = { innerHTML: '', querySelectorAll: () => [] };
  globalThis.document = { getElementById: () => region };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  let identity = 'first', reply = { events: [{ event_id: 2 }, { event_id: 3 }] };
  const reads = [], observations = [], renderedNeeds = [], renderPreferences = [];
  const runtime = dashboardRuntime({
    model: (project, events, options) => { observations.push({ events, options }); return {}; },
    html: (_state, options) => { renderedNeeds.push(options.needs); renderPreferences.push(options); return ''; }, summary: () => null, current: () => '/private-fixture', redraw: () => {},
    boardPath: () => '/api/boards/' + identity,
    api: async path => { reads.push(path); return reply; },
  });
  const project = { root: '/private-fixture', sequence: 3, observedAt: '2026-10-27T12:00:00Z' };
  runtime.draw(project, ''); await delivered(); runtime.draw(project, '');
  const preferences = new Intl.DateTimeFormat().resolvedOptions();
  assert.equal(renderPreferences.at(-1).locale, preferences.locale, 'the browser adapter supplies the reader locale');
  assert.equal(renderPreferences.at(-1).timeZone, preferences.timeZone, 'the browser adapter supplies the reader timezone');
  assert.equal(observations.at(-1).options.complete, false, 'an array response missing the initial prefix cannot certify zero counts');
  assert.match(region.innerHTML, /history is unavailable/u);

  identity = 'replacement'; reply = { events: [{ event_id: 1 }, { event_id: 2 }, { event_id: 3 }, { event_id: 4 }] };
  runtime.draw(project, ''); await delivered(); runtime.draw(project, '');
  assert.equal(reads.at(-1), '/api/boards/replacement/events?after=0', 'a different native board starts a fresh history read');
  assert.equal(observations.at(-1).options.complete, true);
  assert.deepEqual(observations.at(-1).events.map(event => event.event_id), [1,2,3], 'events beyond the displayed sequence never enter the projection');
  assert.equal(observations.at(-1).options.now, Date.parse(project.observedAt), 'the API observation clock governs rates and lease windows');
  const sameSnapshotCalls = observations.length;
  runtime.draw(project, '');
  assert.equal(observations.length, sameSnapshotCalls, 'returning to the exact native snapshot reuses its already-derived history');
  project.observedAt = '2026-10-27T12:00:01Z';
  runtime.draw(project, '');
  assert.equal(observations.length, sameSnapshotCalls + 1, 'even the same object with a new API clock must recompute its windows');
  assert.equal(observations.at(-1).options.now, Date.parse(project.observedAt));
  project.items = [{ id: 9, title: 'New live content at this prefix' }];
  runtime.draw(project, '');
  assert.equal(observations.length, sameSnapshotCalls + 2, 'changed live fields are never hidden behind a prefix-only cache');

  reply = { events: [{ event_id: 1 }, { event_id: 2 }] };
  runtime.draw({ ...project, sequence: 2 }, ''); await delivered(); runtime.draw({ ...project, sequence: 2 }, '');
  assert.equal(reads.at(-1), '/api/boards/replacement/events?after=0', 'a backwards native prefix cannot reuse a later board history');
  assert.equal(observations.at(-1).options.complete, true);
  runtime.draw(project, 'current compact needs');
  runtime.draw({ ...project, observedAt: '2026-10-27T12:01:00Z' });
  assert.equal(renderedNeeds.at(-1), 'current compact needs', 'clock-only redraw retains the selected board compact calls');
  runtime.draw({ ...project, root: '/another-board' });
  assert.equal(renderedNeeds.at(-1), '', 'another board never inherits prior compact calls');
});
