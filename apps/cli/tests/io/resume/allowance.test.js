/** A coordinator seat's resume warns at 20 percent and 5 percent of its Codex allowance left, says unknown without a reading, and stays quiet above 20 [C7,#1058]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';

import { createE2eHelpers } from '../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** One Codex token_count row, with or without the primary rate limit. */
function row(limits) {
  return JSON.stringify({ type: 'event_msg', timestamp: '2026-11-12T12:00:00.000Z', payload: { type: 'token_count', info: null, ...(limits ? { rate_limits: { primary: limits } } : {}) } }) + '\n';
}

/** Run resume as the coordinator of a real project whose Codex session file holds `lines`; returns its printed lines. */
async function coordinatorResume(...lines) {
  const box = e2e.project();
  const file = join(box.dir, 'rollout.jsonl');
  writeFileSync(file, lines.join(''));
  delete box.env.CLAUDE_CODE_SESSION_ID;
  box.env.PULLBOARD_SESSION_LOG = file;
  box.env.CODEX_THREAD_ID = 'allowance-fixture-thread';
  const resumed = await box.runLocal(box.repo, 'resume');
  assert.equal(resumed.code, 0, resumed.err || resumed.out);
  return resumed.out.split('\n');
}

test('cli.journeys-resume-allowance.fifteen-percent-left-warns-with-seat-percent-and-reset: clause 1: a coordinator seat whose Codex session shows 15 percent left prints one warning line naming the seat, the percent left and the reset time [C7,#1058]', async () => {
  const out = await coordinatorResume(row({ used_percent: 85, window_minutes: 300, resets_at: 1800000000 }));
  assert.deepEqual(out.filter(line => /allowance/u.test(line)), ['warning: coordinator allowance 15% left, resets 2027-01-15T08:00:00.000Z']);
});

test('cli.journeys-resume-allowance.four-percent-is-urgent-and-no-reading-is-unknown: clause 2: a coordinator seat at 4 percent left prints one urgent line, and a seat with no rate_limits row prints its allowance as unknown [C7,#1058]', async () => {
  const urgent = await coordinatorResume(row({ used_percent: 96, window_minutes: 300, resets_at: 1800000000 }));
  assert.deepEqual(urgent.filter(line => /allowance/u.test(line)), ['urgent: coordinator allowance 4% left, resets 2027-01-15T08:00:00.000Z']);
  const unknown = await coordinatorResume(row(null));
  assert.deepEqual(unknown.filter(line => /allowance/u.test(line)), ['coordinator allowance: unknown']);
});

test('cli.journeys-resume-allowance.sixty-percent-left-prints-no-allowance-line: clause 3: a coordinator seat at 60 percent left prints no allowance line [C7,#1058]', async () => {
  const out = await coordinatorResume(row({ used_percent: 40, window_minutes: 300, resets_at: 1800000000 }));
  assert.deepEqual(out.filter(line => /allowance/u.test(line)), []);
});
