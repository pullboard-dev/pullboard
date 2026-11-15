/**
 * Shared notice assertion for the known-main output journeys: exact wording, case identity and receipt custody [V4,B3,C7].
 *
 * Why shared: the journeys are split across files so each stays well under the per-file budget, since every case runs a
 * real compared test and some a real submit.
 */
import assert from 'node:assert/strict';

export const FILE = 'test/affected.test.js';
export const NAME = 'affected case [G1]';

/** Exact wording, case identity and receipt custody are shared by both command documents. */
export function notice(value, box, { owner, only = false } = {}) {
  assert.equal(value.file, FILE);
  assert.equal(value.name, NAME);
  assert.equal(value.main, box.main);
  assert.match(value.receiptId, /^[a-f0-9-]{36}$/u);
  const expected = only ? `fails only with your change: ${FILE} :: ${NAME}`
    : `also fails on main at ${box.main}: ${FILE} :: ${NAME} (not yours; ${owner ? `owner #${owner}` : 'accepted'})`;
  assert.equal(value.message, `${expected} [main receipt ${value.receiptId}]`);
  assert.equal(value.status, only ? 'candidate-only' : 'also-main');
}
