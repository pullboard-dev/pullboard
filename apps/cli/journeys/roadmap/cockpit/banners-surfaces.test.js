/** Every banner the view shows, built from the seeded refusal board, shows no code, command, token or relay term [C6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personSurfaceLeaks } from '../../../tests/fixtures/person-surfaces.js';
import { seededPersonBoard } from '../../../tests/fixtures/person-surfaces.js';
import { hostedState } from '../../../../view/src/logic/hosted/render.js';

const STATES = ['looking', 'local-open', 'asking', 'blocked', 'not-running', 'mismatch', 'problem', 'signed-out', 'no-linked', 'unpaired', 'signed-out-paired', 'linked-failed', 'local-failed'];
// The copy box's command and the sentence for the agent are the one thing the screen asks the person to do, so they are not banner prose.
const PROSE = ['heading', 'text', 'small', 'live', 'lead', 'help', 'detail'];

/** The words a banner model shows the person. */
const words = (model) => PROSE.flatMap((key) => (typeof model[key] === 'string' ? [model[key]] : []));

test('every banner state, over every refusal in the seeded board, is free of codes, commands, tokens and relay terms [C6,N26]', () => {
  const board = seededPersonBoard();
  assert.ok(board.length > 100, 'one refusal per catalog entry, never hand-listed');
  const leaks = new Set();
  for (const state of STATES) {
    for (const facts of [{}, { phone: true }, { listed: true, localOriginKnown: true, signedIn: true }, { linked: ['alpha', 'beta'] }]) {
      const model = hostedState(state, { ...facts, detail: undefined });
      assert.ok(model, state);
      for (const text of words(model)) for (const leak of personSurfaceLeaks(text)) leaks.add(`${state}: ${leak.kind}: ${leak.match}`);
    }
    for (const { agentText, next } of board) {
      for (const detail of [agentText, `${agentText} ${next}`]) {
        for (const text of words(hostedState(state, { detail }))) for (const leak of personSurfaceLeaks(text)) leaks.add(`${state}: ${leak.kind}: ${leak.match}`);
      }
    }
  }
  assert.deepEqual([...leaks], []);
});

test('a refusal handed to a banner as plain words is shown as written [C6,N26]', () => {
  const detail = 'This computer could not reach the board.';
  assert.equal(hostedState('local-failed', { detail }).detail, detail);
});

test('a bracketed code in a refusal is dropped from a banner and its plain words stay [C6,N26]', () => {
  assert.equal(hostedState('problem', { detail: '[RELAY_UNAVAILABLE] The relay is busy.' }).text, 'The relay is busy.');
  assert.equal(hostedState('problem').text, 'This page could not take the connection Pullboard on this computer sent back.');
});
