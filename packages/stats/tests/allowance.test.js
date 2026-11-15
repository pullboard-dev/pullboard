/** A seat's allowance comes from the latest Codex rate_limits.primary, and is unknown without one [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../apps/cli/tests/fixtures/child.js';
import { seatAllowance } from '../src/io/cost/session.js';

/** One Codex token_count row, with or without rate limits. */
function row(limits) {
  return JSON.stringify({ type: 'event_msg', timestamp: '2026-11-12T12:00:00.000Z', payload: { type: 'token_count', info: null, ...(limits ? { rate_limits: { primary: limits } } : {}) } }) + '\n';
}

/** A private session file holding the given lines. */
function session(t, ...lines) {
  const scratch = privateFixtureFiles('pullboard-allowance-');
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));
  const file = join(scratch.root, 'rollout.jsonl');
  writeFileSync(file, lines.join(''));
  return file;
}

test('the latest rate_limits.primary becomes percent left and a reset time [C7]', t => {
  const file = session(t, row({ used_percent: 10, window_minutes: 300, resets_at: 1000 }), row(null), row({ used_percent: 85, window_minutes: 300, resets_at: 1800000000 }));
  assert.deepEqual(seatAllowance(file), { known: true, percentLeft: 15, windowMinutes: 300, resetsAt: '2027-01-15T08:00:00.000Z' });
});

test('a session with no rate_limits, no file or garbage numbers is unknown, never a number [C7]', t => {
  assert.deepEqual(seatAllowance(session(t, row(null), 'not json\n')), { known: false });
  assert.deepEqual(seatAllowance(join(session(t), 'missing.jsonl')), { known: false });
  assert.deepEqual(seatAllowance(session(t, row({ used_percent: 'x', window_minutes: 300, resets_at: 5 }))), { known: false });
});
