/** No Pullboard internal reaches a person-facing surface, and agent-facing output keeps its codes [H23,C6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personSurfaceLeaks } from '../../../tests/fixtures/person-surfaces.js';
import { seededPersonBoard } from '../../../tests/fixtures/person-surfaces.js';
import { refusalDocument } from '../../../index.js';
import { hostedState } from '../../../../view/index.js';
import { needsEntries } from '../../../../view/index.js';
import { needsPanelModel } from '../../../../view/index.js';
import { personNeeds } from '../../../../../packages/spec/index.js';
import { Refused } from '../../../../../packages/kernel/light.js';

const AT = '2026-11-12T12:00:00.000Z';
const STATES = ['looking', 'local-open', 'asking', 'blocked', 'not-running', 'mismatch', 'problem', 'signed-out', 'no-linked', 'unpaired', 'signed-out-paired', 'linked-failed', 'local-failed'];
// A banner's copy box command is the one thing the screen asks the person to do, so it is not banner prose.
const PROSE = ['heading', 'text', 'small', 'live', 'lead', 'help', 'detail'];

/** Every string a model or entry carries, so no field hides from the detector. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) strings(inner, out);
  return out;
}

/** The leaks found in each text, as "surface: kind: match". */
function leaksOf(surface, texts) {
  return texts.flatMap(text => personSurfaceLeaks(text).map(leak => `${surface}: ${leak.kind}: ${leak.match}`));
}

test('cli.journeys-help-surfaces-all.no-internals-reach-a-person-facing: no internals reach a person-facing surface [H23,C6,N26]', () => {
  const board = seededPersonBoard();
  assert.ok(board.length > 100, 'one case per catalog refusal, never hand-listed');
  const leaks = new Set();
  // Refusal lines: what the person reads when a request is refused.
  for (const { code } of board) {
    const { error } = refusalDocument(new Refused(code, 'refused for the fixture'), { caller: 'person' });
    for (const leak of leaksOf(`refusal ${code}`, [`${error.message}\n${error.next}`])) leaks.add(leak);
  }
  // Needs you entries and notifications (the relay-health call is what the person is pinged about), built from the same board.
  const blocks = board.map(({ code, next }) => ({ at: AT, code, command: `pullboard ${code.toLowerCase()}`, audience: 'person', reason: 'the request was refused', step: next }));
  const notification = { kind: 'relay-health', id: 'relay-canary', ref: 'relay', at: AT, text: 'relay degraded since 12:00; your moves are queued locally (2)',
    what: 'the last canary probe failed during sync (RELAY_CANARY_FAILURE); inspect pullboard relay canary and keep working locally' };
  const calls = [...personNeeds({ blocks }), notification];
  for (const leak of leaksOf('needs', needsEntries(calls, []).flatMap(entry => strings(entry)))) leaks.add(leak);
  for (const leak of leaksOf('needs panel', strings(needsPanelModel(calls, { holds: [], items: [], spec: [] }).questions.map(({ source, ...row }) => row)))) leaks.add(leak);
  // View banners, over every state and every refusal as the detail.
  for (const state of STATES) {
    for (const { agentText, next } of board) {
      for (const detail of [agentText, `${agentText} ${next}`]) {
        const model = hostedState(state, { detail });
        for (const leak of leaksOf(`banner ${state}`, PROSE.flatMap(key => (typeof model[key] === 'string' ? [model[key]] : [])))) leaks.add(leak);
      }
    }
  }
  assert.deepEqual([...leaks], []);
});

test('cli.journeys-help-surfaces-all.agent-facing-output-keeps-its-codes: clause 2: agent-facing output keeps its codes [H23,C6,N26]', () => {
  const [{ code, agentText }] = seededPersonBoard();
  const seat = refusalDocument(new Refused(code, 'refused for the fixture'), { caller: 'seat' });
  assert.equal(seat.error.code, code, 'the seat sees the refusal code');
  assert.match(agentText, new RegExp(`^\\[${code}\\]`, 'u'), 'agent text keeps its bracketed code');
  assert.notEqual(personSurfaceLeaks(agentText).length, 0, 'the detector sees the code that a seat keeps');
});
