/** #10315: clicking an In the gate row on the Dashboard opens that item's gate trace panel, phase by phase in ms [C7,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readGateJobs } from '../../../src/io/dashboard/gates.js';
import { dashboardRuntime } from '../../../index.js';
import { dashboardModel } from '../../../src/io/dashboard/model.js';
import { dashboardHtml } from '../../../src/logic/render/dashboard.js';
import { gateTrace } from '../../../src/logic/gate-trace.js';

const T0 = Date.parse('2026-11-17T15:00:00Z');
const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
const ms = value => value.toLocaleString(locale) + ' ms';
const step = (name, seq, at, payload = {}) => ({ name, seq, payload, at: T0 + at });
const FINISHED = { id: 'gate-7', item: 7, step: 'done', created: T0, updated: T0 + 90_000, steps: [
  step('section:static', 1, 0, { endedAt: T0 + 5_000 }), step('dispatch', 2, 6_000), step('shard:a', 3, 8_000, { shard: 'a', endedAt: T0 + 50_000 }), step('section:landing', 4, 60_000),
] };

/** A project whose items 7.. sit in the gate (submitted, no verdict yet), with the given gate jobs and observation clock. */
function projectOf(gates, { observedAt = T0 + 100_000, extra = 0 } = {}) {
  const items = Array.from({ length: 1 + extra }, (_, index) => ({ id: 7 + index, title: 'Gate item ' + (7 + index), status: 'submitted', lane: 'view', updatedAt: new Date(T0 - 60_000).toISOString() }));
  return { root: '/gate-fixture', sequence: 0, observedAt: new Date(observedAt).toISOString(), items, events: [], agents: [], milestones: [], dashboardRunners: { runners: [], runs: [], gates } };
}

/** The runtime over a fake page region: clicks reach the region's own listener the way a browser delivers them. */
function page(t) {
  const previous = globalThis.document;
  const region = { innerHTML: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, querySelectorAll: () => [], querySelector: () => null };
  globalThis.document = { getElementById: () => region };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  let project = null;
  const runtime = dashboardRuntime({ model: dashboardModel, html: dashboardHtml, gateTrace, api: async () => ({ events: [] }), boardPath: () => '/api/boards/gate', current: () => project.root, redraw: () => runtime.draw(project, ''), summary: () => null });
  return {
    region,
    show(next) { project = next; runtime.draw(project, ''); },
    click(id) { region.listeners.click({ target: { closest: selector => selector === '[data-gate-trace]' ? { dataset: { gateTrace: String(id) } } : null } }); },
  };
}

test('view.x-io-dashboard-gate-trace-panel.clause-1-clicking-a-gate-row-opens: clause 1: clicking a gate row opens a panel listing each phase of gate-trace.js with its duration in ms [C7,N26]', t => {
  const shown = page(t);
  shown.show(projectOf({ 7: FINISHED }));
  assert.match(shown.region.innerHTML, /data-gate-trace="7"/u, 'the In the gate row is a button that opens the trace');
  assert.doesNotMatch(shown.region.innerHTML, /data-gate-panel/u, 'the panel starts shut');
  shown.click(7);
  const html = shown.region.innerHTML;
  assert.match(html, /data-gate-panel="7"/u, 'the click opens item 7\'s panel');
  const phases = gateTrace(FINISHED).phases;
  assert.ok(phases.length >= 5, 'the fixture has phases and a gap');
  for (const phase of phases) {
    const row = new RegExp('<li class="dash-gp [^"]*"[^>]*data-gate-phase="' + (phase.type === 'gap' ? 'gap' : phase.name) + '">.*?' + ms(phase.ms).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '</span></li>', 'u');
    assert.match(html, row, (phase.type === 'gap' ? 'the gap' : phase.name) + ' is listed with ' + ms(phase.ms));
  }
  assert.match(html, /Finished · /u, 'a done gate reads finished');
  shown.click(7);
  assert.doesNotMatch(shown.region.innerHTML, /data-gate-panel/u, 'a second click shuts the panel');
});

test('view.x-io-dashboard-gate-trace-panel.clause-2-the-open-panel-of-a: clause 2: the open panel of a running gate names its current phase and re-renders when the next live state arrives [C7,N26]', t => {
  const shown = page(t);
  const running = steps => ({ id: 'gate-7', item: 7, step: 'run', created: T0, updated: T0 + 10_000, steps });
  shown.show(projectOf({ 7: running([step('section:static', 1, 0), step('shard:a', 2, 10_000, { shard: 'a' })]) }, { observedAt: T0 + 25_000 }));
  shown.click(7);
  assert.match(shown.region.innerHTML, /Running · now in <b>shard:a<\/b>/u, 'the panel names the phase the gate is in');
  assert.match(shown.region.innerHTML, new RegExp('data-gate-phase="shard:a">.*?' + ms(15_000) + '</span></li>'), 'the open phase has run until the observation clock');
  shown.show(projectOf({ 7: running([step('section:static', 1, 0), step('shard:a', 2, 10_000, { shard: 'a' }), step('shard:b', 3, 30_000, { shard: 'b' })]) }, { observedAt: T0 + 42_000 }));
  assert.match(shown.region.innerHTML, /data-gate-panel="7"/u, 'the panel stays open across the live redraw');
  assert.match(shown.region.innerHTML, /Running · now in <b>shard:b<\/b>/u, 'the next live state moves the current phase');
  assert.match(shown.region.innerHTML, new RegExp('data-gate-phase="shard:b">.*?' + ms(12_000) + '</span></li>'));
});

test('view.x-io-dashboard-gate-trace-panel.clause-1-a-gate-row-with-no: clause 1: a gate row with no recorded job opens a panel that says so, and the item stays one click away [C7,N26]', t => {
  const shown = page(t);
  shown.show(projectOf({}));
  shown.click(7);
  assert.match(shown.region.innerHTML, /No gate record for this item yet\./u);
  assert.match(shown.region.innerHTML, /data-go="item:7"/u, 'the panel offers the item itself');
});

test('view.x-io-dashboard-gate-trace-panel.clause-3-the-panel-opens-in-under: clause 3: the panel opens in under 200 ms on a large board with 300 items in the gate [C7,N26]', t => {
  const shown = page(t);
  const extra = 2_000;
  const gates = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [7 + index, { ...FINISHED, id: 'gate-' + (7 + index), item: 7 + index,
    steps: Array.from({ length: 40 }, (__, at) => step(at % 5 === 0 ? 'section:s' + at : 'shard:' + at, at + 1, at * 1_000, { shard: String(at) })) }]));
  const project = projectOf(gates, { extra });
  shown.show(project);
  const started = performance.now();
  shown.click(7);
  const took = performance.now() - started;
  assert.match(shown.region.innerHTML, /data-gate-panel="7"/u);
  console.log('gate trace panel open: ' + took.toFixed(1) + ' ms on ' + project.items.length + ' items, 300 gate jobs');
  assert.ok(took < 200, 'the panel opened in ' + took.toFixed(1) + ' ms'); // budget: item #10315 bar clause 3, measured on this large board
});

test('view.x-io-dashboard-gate-trace-panel.clause-1-the-server-reads-each-item: clause 1: the server reads each item\'s newest gate job and its phase steps, and leaves keepsakes and liveness rows out [C7,N26]', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE job (job_id TEXT PRIMARY KEY, job_kind TEXT, job_item INTEGER, job_step TEXT, job_created INTEGER, job_updated INTEGER);
    CREATE TABLE job_step (job_step_id INTEGER PRIMARY KEY, job_step_job TEXT, job_step_name TEXT, job_step_seq INTEGER, job_step_payload TEXT, job_step_at INTEGER);`);
  const job = (id, kind, item, state, created) => db.prepare('INSERT INTO job VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, item, state, created, created + 1_000);
  const add = (id, name, at, payload = '{}') => db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_seq, job_step_payload, job_step_at) VALUES (?, ?, 0, ?, ?)').run(id, name, payload, at);
  job('old', 'gate', 7, 'done', T0 - 3_000_000); add('old', 'section:static', T0 - 3_000_000);
  job('new', 'gate', 7, 'run', T0); add('new', 'section:static', T0, '{"endedAt":123,"secret":"x"}'); add('new', 'artifact:log', T0 + 1); add('new', 'alive', T0 + 2); add('new', 'shard:a', T0 + 3, 'not json');
  job('land', 'landing-run', 8, 'run', T0); add('land', 'section:static', T0);
  job('stale', 'gate', 9, 'done', T0 - 5 * 3_600_000); add('stale', 'section:static', T0 - 5 * 3_600_000);
  const found = readGateJobs(import.meta.filename, T0 + 60_000, { open: () => db, jobsFor: handle => ({ jobs: handle, close() {} }) });
  assert.deepEqual(Object.keys(found), ['7'], 'only the gate kind inside the four hours, one job per item');
  assert.equal(found[7].id, 'new', 'the newest gate job of the item');
  assert.deepEqual(found[7].steps.map(entry => entry.name), ['section:static', 'shard:a'], 'no artifact keepsake, no alive row');
  assert.deepEqual(found[7].steps[0].payload, { endedAt: 123, shard: undefined }, 'only the fields a trace reads are kept');
  assert.equal(found[7].steps[1].payload, null, 'a payload that is not JSON is dropped');
});
