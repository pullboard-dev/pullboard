/** The person-surface detector flags internals and passes plain text; the seeded board covers every catalog refusal [H23]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personSurfaceLeaks } from '../../../tests/fixtures/person-surfaces.js';
import { seededPersonBoard } from '../../../tests/fixtures/person-surfaces.js';
import { DEFAULT_NEXT_STEPS } from '../../../../../packages/state/light.js';

test('cli.journeys-relay-person-surfaces-fixture.the-detector-flags-a-bracketed-code: the detector flags a bracketed code, a command line, a token and a relay term [H23]', () => {
  assert.deepEqual(personSurfaceLeaks('Failed [RELAY_UNAVAILABLE] today').map((l) => l.kind), ['bracketed code']);
  assert.deepEqual(personSurfaceLeaks('Run pullboard next to continue').map((l) => l.kind), ['shell command line']);
  assert.deepEqual(personSurfaceLeaks('key sk-abcdefghijklmnop1234').map((l) => l.kind), ['token or key']);
  for (const word of ['checkpoint', 'outbox', 'digest', 'lease']) {
    assert.deepEqual(personSurfaceLeaks(`The ${word} is late`).map((l) => l.kind), ['relay term'], word);
  }
});

test('cli.journeys-relay-person-surfaces-fixture.the-detector-passes-plain-person-text: the detector passes plain person text [H23]', () => {
  for (const text of ['Your agents are working. Nothing needs you.', 'Which design should we keep?', '', undefined]) {
    assert.deepEqual(personSurfaceLeaks(text), [], String(text));
  }
});

test('cli.journeys-relay-person-surfaces-fixture.the-seeded-board-holds-a-case: the seeded board holds a case for every catalog refusal [H23]', () => {
  const board = seededPersonBoard();
  const codes = Object.keys(DEFAULT_NEXT_STEPS);
  assert.ok(codes.length > 0);
  assert.deepEqual(board.map((c) => c.code), codes);
  for (const item of board) {
    assert.match(item.agentText, new RegExp(`^\\[${item.code}\\]`, 'u'), 'agent text keeps its code');
    assert.ok(item.next, `${item.code} has a next step`);
  }
});
