/** Generated browser adapters over real writer receipts; this control does not claim Chrome execution [N2,N26]. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import {
  lifecycleEvent,
  lifecycleMove,
} from '../../../../../packages/items/index.js';
import { replayItem } from '../../../../view/index.js';
import { timelineHtml } from '../../../../view/index.js';
import { activityModel } from '../../../../view/index.js';

/** Exercise the actual served functions with native accounting receipts supplied by the writer journey. */
export function assertUsagePresentation(events, itemId, board) {
  assert.ok(board && typeof board.root === 'string' && board.root.length > 0, 'the writer supplies its actual fixture board root');
  assert.ok(Array.isArray(board.agents), 'the writer supplies actual registered agent rows');
  const accounting = events.filter(event => ['usage', 'shared-usage'].includes(event.event_kind));
  assert.ok(accounting.length, 'the presentation control requires actual writer receipts');
  const original = JSON.stringify(events), ids = events.map(event => event.event_id);
  const served = cockpitPage('', { snapshot: true });
  const declaration = /const FLOW = ([^\n]+);/u.exec(served);
  assert.ok(declaration, 'the served lifecycle is present');
  const FLOW = JSON.parse(declaration[1]);
  /** Extract a complete top-level production function from the emitted page, not a test reimplementation. */
  const emitted = name => {
    const start = served.indexOf('function ' + name + '(');
    const end = served.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, 'the served ' + name + ' function is present');
    return served.slice(start, end);
  };
  const native = events.filter(event => event.item_id === itemId);
  assert.ok(native.some(event => event.event_kind === 'add'));
  // A historical projection may still contain accounting. Derive its rows from real receipts,
  // without inventing events or changing their native item_id, identity, payload or ordering.
  const compatibility = [...native, ...accounting].sort((a, b) => a.event_id - b.event_id);
  const history = compatibility.map(lifecycleEvent);
  const thread = compatibility.map(event => ({ type: 'move', eventId: event.event_id,
    ...lifecycleEvent(event), detail: JSON.parse(event.event_detail) }));
  const item = { id: itemId, status: FLOW.initial, history, thread, verdicts: [] };
  const final = { root: board.root, agents: board.agents, items: [item], events, shouts: [], decisions: [], asked: [], decisionQueue: [], holds: [], milestones: [] };
  const snapshotReplay = { events, final, index: events.length, playing: false };
  const nodes = new Map();
  /** Return a stable minimal DOM node for the generated replay controls. */
  function node(id) {
    if (!nodes.has(id)) {
      const value = {};
      /** Preserve the ARIA attribute the served control updates. */
      value.setAttribute = (name, text) => { value[name] = text; };
      nodes.set(id, value);
    }
    return nodes.get(id);
  }
  const $ = id => node(id);
  const context = { snapshotReplay, structuredClone, FLOW, lifecycleEvent, lifecycleMove, $ };
  /** Evaluate a served top-level arrow helper, such as eventWords, in the given context. */
  const emittedConst = (name, scope) => {
    const declaration = new RegExp('^const ' + name + ' = ([^\\n]+);$', 'mu').exec(served);
    assert.ok(declaration, 'the served ' + name + ' helper is present');
    return vm.runInNewContext('(' + declaration[1] + ')', scope);
  };
  // Event labels come from the page's own plain-words helpers, so bind the served ones [N26].
  const words = {};
  words.activityWords = vm.runInNewContext('(' + emitted('activityWords') + ')', words);
  words.eventWords = emittedConst('eventWords', words);
  words.eventMoment = emittedConst('eventMoment', words);
  Object.assign(context, words);
  const replayProject = vm.runInNewContext('(' + emitted('replayProject') + ')', context);
  const replayControls = vm.runInNewContext('(' + emitted('replayControls') + ')', context);
  const positions = new Set([events.length, ...accounting.map(event => events.indexOf(event) + 1)]);
  for (const index of positions) {
    snapshotReplay.index = index;
    const projected = replayProject(index);
    for (const row of projected.items) {
      assert.ok(row.history.every(entry => !['usage', 'shared-usage'].includes(entry.kind)), 'partial and final replay history omit accounting');
      assert.ok((row.thread || []).every(entry => !['usage', 'shared-usage'].includes(entry.kind)), 'partial and final replay thread omit accounting');
    }
    const expected = index === events.length ? ids : events.slice(0, index).slice(-80).reverse().map(event => event.event_id);
    assert.deepEqual(Array.from(projected.events, event => event.event_id), expected, 'projection preserves its raw event window');
    replayControls();
    assert.ok($('replay-progress').textContent.startsWith('event ' + index.toLocaleString('en-US') + ' of ' + events.length.toLocaleString('en-US')), 'the counter names its current event and complete denominator');
    assert.doesNotMatch($('replay-progress').textContent, /(?:shared-)?usage/u, 'the replay label omits accounting');
  }
  const data = { project: final };
  const view = { root: final.root, timelineOpen: new Map() };
  const timeline = vm.runInNewContext('(' + emitted('timeline') + ')', {
    data, view, FLOW, lifecycleEvent, replay: row => replayItem(row, FLOW, lifecycleMove), renderTimelineHtml: timelineHtml,
    when: value => value, age: () => '', agentName: value => value,
    privateCost: false,
    ...words,
  });
  for (const row of [item, { ...item, thread: [] }]) {
    const html = timeline(row);
    assert.doesNotMatch(html, />\s*(?:shared-)?usage\s*</u, 'both thread and legacy timeline omit accounting');
    assert.match(html, /data-timeline-kind="add"/u, 'ordinary native add history is still rendered');
    assert.match(html, /added this work/u, 'ordinary add history uses the accepted timeline sentence');
    if (row.thread.length) {
      const added = native.find(event => event.event_kind === 'add');
      assert.ok(html.includes('data-event-id="' + added.event_id + '"'), 'the native add event identity survives presentation');
    }
  }
  assert.ok(activityModel(final).rows.every(row => !['usage', 'shared-usage'].includes(row.kind)), 'Activity omits accounting');
  assert.equal(JSON.stringify(events), original, 'UI projection never rewrites writer receipts');
  assert.deepEqual(snapshotReplay.events.map(event => event.event_id), ids, 'the replay source log remains complete');
}
