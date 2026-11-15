/** Every Needs you entry, built from the seeded refusal board, shows no code, command, token or relay term [C6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personSurfaceLeaks } from '../../../../cli/tests/fixtures/person-surfaces.js';
import { seededPersonBoard } from '../../../../cli/tests/fixtures/person-surfaces.js';
import { personNeeds } from '../../../../../packages/spec/index.js';
import { needsEntries } from '../../../src/logic/needs/list.js';
import { renderNeedsRow } from '../../../src/logic/needs/list.js';
import { needsPanelModel } from '../../../src/logic/needs/panel.js';

const AT = '2026-11-12T12:00:00.000Z';

/** Every string a row model or entry carries, so no field hides from the detector. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) strings(inner, out);
  return out;
}

/** The seeded board as the person's blocks, one per catalog refusal with the catalog's own step. */
function seededCalls() {
  const blocks = seededPersonBoard().map(({ code, next }) => ({ at: AT, code, command: 'pullboard ' + code.toLowerCase(),
    audience: 'person', reason: 'the request was refused', step: next }));
  const relay = { kind: 'relay-health', id: 'relay-canary', ref: 'relay', at: AT, text: 'relay degraded since 12:00; your moves are queued locally (2)',
    what: 'the last canary probe failed during sync (RELAY_CANARY_FAILURE); inspect pullboard relay canary and keep working locally' };
  const pending = { kind: 'pending', id: 'G1.2', ref: 'G1.2', text: 'Which design should we keep?', what: 'pullboard spec answer G1.2 "<choice>"' };
  return [...personNeeds({ blocks }), relay, pending];
}

test('every Needs you entry from the seeded board is free of codes, commands, tokens and relay terms [C6,N26]', () => {
  const calls = seededCalls();
  assert.ok(calls.length > 100, 'one block per catalog refusal, never hand-listed');
  const shown = [
    ...needsEntries(calls, []).flatMap((entry) => strings(entry)),
    ...strings(needsPanelModel(calls, { holds: [], items: [], spec: [] }).questions.map(({ source, ...row }) => row)),
    ...needsEntries(calls, []).map((entry) => renderNeedsRow((row, context, action) => strings([row, context, action]).join(' | '), () => '', entry)),
  ];
  const leaks = shown.flatMap((text) => personSurfaceLeaks(text).map((leak) => `${leak.kind}: ${leak.match}`));
  assert.deepEqual([...new Set(leaks)], []);
});

test('an entry already in plain words is shown as it was written [C6,N26]', () => {
  const calls = [{ kind: 'block', id: 'block:a', ref: 'blocked', at: AT, text: 'Pullboard stopped a request that only you can clear: spend is high', what: 'Raise the budget in the machine settings.' }];
  assert.deepEqual(needsEntries(calls, []), [[null, 'blocked', calls[0].text, calls[0].what, AT, 'block']]);
});
