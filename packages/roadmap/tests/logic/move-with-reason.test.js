/** The coordinator moves a board-placed item between milestones with a recorded reason; with no reason the move is refused [C7,#4028]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editMilestoneItems } from '../../index.js';
import { roadmap } from '../../index.js';

const COORDINATOR = 'coordinator';

/** Two open releases, with item 1 placed in A by rule; ports stand in for the board store. */
function kit() {
  let stored = [{ name: 'A', note: null, items: [1] }, { name: 'B', note: null, items: [] }];
  const events = [];
  const items = new Map([[1, { item_id: 1, item_title: 'Placed by rule', item_status: 'open', item_merged_commit: null }]]);
  const board = {
    clock: { now: () => new Date('2026-11-17T00:00:00Z') },
    db: {
      prepare: sql => sql.startsWith('SELECT 1 FROM event')
        ? { get: () => ({ 1: 1 }) }
        : { run: (key, value) => { stored = JSON.parse(value); } },
    },
  };
  const ports = {
    atomic: (_board, work) => work(),
    itemById: (_board, id) => { if (!items.has(id)) throw new Error(`no item ${id}`); return items.get(id); },
    logEvent: (_board, agent, kind, item, detail) => events.push({ agent, kind, item, detail }),
    milestones: () => structuredClone(stored),
    listItems: () => [...items.values()],
    PERSON: 'person',
  };
  return { board, ports, events, read: () => roadmap(board, null, ports) };
}

test('roadmap.logic-move-with-reason.clause-1-the-coordinator-moves-an-item-between: clause 1: the coordinator moves an item to another milestone with a reason, the event records it and the roadmap lists the item there [C7,#4028]', () => {
  const { board, ports, events, read } = kit();
  editMilestoneItems(board, 'B', { agentId: COORDINATOR, add: [1], reason: 'the person moved it to the later release' }, ports);
  const roadmapNow = read();
  assert.deepEqual(roadmapNow.find(entry => entry.name === 'B').items.map(entry => entry.id), [1]);
  assert.deepEqual(roadmapNow.find(entry => entry.name === 'A').items.map(entry => entry.id), [], 'the item leaves the milestone it was placed in');
  const moved = events.find(event => event.kind === 'milestone_items');
  assert.equal(moved.detail.reason, 'the person moved it to the later release');
  const override = events.find(event => event.kind === 'milestone_placed');
  assert.equal(override.detail.rule, 'override');
  assert.equal(override.detail.reason, 'the person moved it to the later release');
});

test('roadmap.logic-move-with-reason.clause-2-the-move-is-refused-with-no: clause 2: moving a board-placed item with no reason is refused and changes nothing [C7,#4028]', () => {
  const { board, ports, events, read } = kit();
  assert.throws(() => editMilestoneItems(board, 'B', { agentId: COORDINATOR, add: [1] }, ports),
    error => error.code === 'MILESTONE_PLACED' && error.message.includes('--reason'));
  assert.equal(events.length, 0);
  assert.deepEqual(read().find(entry => entry.name === 'A').items.map(entry => entry.id), [1]);
});
