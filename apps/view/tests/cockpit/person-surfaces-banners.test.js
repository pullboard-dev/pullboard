/** Every banner the view shows, given each seeded refusal, is free of codes, commands, tokens and relay terms [C6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personSurfaceLeaks } from '../../../cli/tests/fixtures/person-surfaces.js';
import { seededPersonBoard } from '../../../cli/tests/fixtures/person-surfaces.js';
import { hostedState } from '../../src/logic/hosted/render.js';

const STATES = ['looking', 'local-open', 'asking', 'blocked', 'not-running', 'mismatch', 'problem', 'signed-out', 'no-linked', 'unpaired', 'signed-out-paired', 'linked-failed', 'local-failed'];

/** The words a banner shows. Its `command` is the one box the person copies on purpose, so it is not banner prose. */
function bannerWords(model) {
  const { command, parts, state, kind, ...words } = model;
  return Object.values(words).filter((value) => typeof value === 'string');
}

test('every banner state shows plain words for each seeded refusal it can be handed [C6,N26]', () => {
  const board = seededPersonBoard();
  assert.ok(board.length > 100, 'one refusal per catalog entry, never hand-listed');
  const leaks = [];
  for (const { agentText, next } of board) {
    for (const detail of [agentText, next]) {
      for (const state of STATES) for (const phone of [false, true]) {
        const model = hostedState(state, { detail, phone, linked: ['alpha'], listed: true, localOriginKnown: true });
        for (const text of bannerWords(model)) leaks.push(...personSurfaceLeaks(text).map((leak) => `${state}: ${leak.kind}: ${leak.match}`));
      }
    }
  }
  assert.deepEqual([...new Set(leaks)], []);
});

test('a plain refusal reason is shown as it was written [C6,N26]', () => {
  assert.equal(hostedState('local-failed', { detail: 'The board is busy right now.' }).detail, 'The board is busy right now.');
  assert.equal(hostedState('problem', { detail: '[RELAY_UNAVAILABLE] The relay is busy.' }).text, 'The relay is busy.');
  assert.equal(hostedState('problem').text, 'This page could not take the connection Pullboard on this computer sent back.');
});
