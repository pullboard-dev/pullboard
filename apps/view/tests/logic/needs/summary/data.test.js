/** Plain obligations and explicit clock observations; native Needs interactions remain journeys [N26,B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personNeeds } from '../../../../../../packages/spec/light.js';
import { heldNote } from '../../../../src/io/held.js';
import { heldChip } from '../../../../src/io/held.js';

test('view.needs-summary-data.only-person-owned-blocks-become-calls-grouped: only person-owned blocks become calls, grouped by command with the latest observed reason [N26,B26,C7]', () => {
  const state = { blocks: [
    { audience: 'agent', code: 'RULE', command: 'build', reason: 'Agent fixes this', at: '2026-10-28T11:00:00Z' },
    { audience: 'person', code: 'RULE', command: 'build', reason: 'First reason', step: 'Choose', at: '2026-10-28T11:01:00Z' },
    { audience: 'person', code: 'OTHER', command: 'build', reason: 'Other rule', step: 'Inspect', at: '2026-10-28T11:02:00Z' },
    { audience: 'person', code: 'RULE', command: 'build', reason: 'Current reason', step: 'Decide', at: '2026-10-28T11:03:00Z' },
  ] };
  const before = JSON.stringify(state);
  const rows = personNeeds(state);
  assert.deepEqual(rows.map(row => [row.id, row.count, row.what]), [['block:RULE build', 2, 'Decide'], ['block:OTHER build', 1, 'Inspect']]);
  assert.match(rows[0].text, /Current reason$/u);
  assert.doesNotMatch(JSON.stringify(rows), /Agent fixes this|First reason/u);
  assert.equal(JSON.stringify(state), before);
});

test('view.needs-summary-data.proposal-eligibility-avoids-duplicate-draft-calls-without: proposal eligibility avoids duplicate draft calls without hiding unresolved or stale rows [N26,B26,C7]', () => {
  const state = { spec: [{ id: 'G1', status: 'draft' }, { id: 'G2', status: 'approved', staleDecision: true },
    { id: 'G3', status: 'draft', decision: { decision: 'decline' } }], rigorDrafts: [
    { kind: 'rigor-draft', id: 'proved', target: 'spec:G1' },
    { kind: 'rigor-draft', id: 'unmaterialized', target: 'spec:G2', unproved: true },
    { kind: 'rigor-draft', id: 'collision', unproved: true, materialized: true, collision: true },
    { kind: 'rigor-draft', id: 'materialized', unproved: true, materialized: true, collision: false },
  ] };
  const before = JSON.stringify(state);
  const rows = personNeeds(state);
  assert.deepEqual(rows.filter(row => row.kind === 'rigor-draft').map(row => row.id), ['proved', 'materialized']);
  assert.equal(rows.find(row => row.kind === 'draft').count, 1, 'the unresolved stale row remains, the represented and decided rows do not duplicate');
  assert.equal(JSON.stringify(state), before);
});

test('view.needs-summary-data.recorded-decisions-remove-revision-actions-while-unresolved: recorded decisions remove revision actions while unresolved revisions preserve their exact identity [N26,B26,C7]', () => {
  const revision = { id: 'G2', revises: 'G1', reason: 'Keep the decision', source: 'Old', replacement: 'New' };
  const rows = personNeeds({ specRevisions: [revision, { ...revision, id: 'G3', decision: 'approve' }] });
  assert.deepEqual(rows[0].actions, [{ verb: 'spec-approve', args: { ids: 'G2' } }, { verb: 'spec-decline', args: { ids: 'G2' } }]);
  assert.deepEqual(rows[1].actions, []);
  assert.equal(rows[1].what, 'approved; pending spec apply');
});

test('view.needs-summary-data.held-presentation-uses-the-supplied-claim-deadline: held presentation uses the supplied claim deadline boundary and preserves own-hold precedence [N26,C7]', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const source = { itemHolds: [{ item: 7, reason: 'Keep <judgment>' }], holds: [{ hold_lane: 'view', hold_reason: 'Lane pause' }] };
  const item = { id: 7, lane: 'view', status: 'claimed', claim: { until: '2026-10-28T12:00:00Z' } };
  assert.equal(heldNote(item, source, undefined, now - 1), null, 'a live builder is not counted held');
  assert.equal(heldNote(item, source, undefined, now), 'held: Keep <judgment>', 'the exact expiry is not a live claim');
  assert.match(heldChip(heldNote(item, source, undefined, now)), /title="held: Keep &lt;judgment&gt;"/u);
  assert.equal(heldNote({ ...item, id: 8 }, source, undefined, now), 'lane view held: Lane pause');
  assert.equal(heldNote(item, source, { state: 'landed' }, now), null);
  assert.equal(heldNote({ ...item, status: 'submitted' }, source, undefined, now), null);
  assert.throws(() => heldNote(item, source), /explicit observation clock/u);
});
