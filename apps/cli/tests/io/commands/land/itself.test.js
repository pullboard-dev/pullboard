/** @pullboard-test-input apps/cli/src/io/commands/hold.js apps/cli/src/io/commands/land.js */
/** Automatic landing schedules its own next wake while verified items wait [C7,#2898]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The wake schedule, the next-batch interval and the busy-board retry belong to the Mac batch engine; a pulled landing is one runner job, so #6807 deletes these cases with it.
test('a blocked or partly landed batch with verified items waiting wakes again one interval later [C7,#2898]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

test('a recorded cadence deferral keeps its own wake time [C7,#2898]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

test('with no verified item waiting, no wake is scheduled [C7,#2898]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

test('releasing a verified item hold wakes landing the way an accept does [C7,#2898]', () => {
  const source = readFileSync(new URL('../../../../src/io/commands/hold.js', import.meta.url), 'utf8');
  assert.match(source, /item_status === 'verified'\) released = ctx/u);
  assert.match(source, /landAfterAcceptance\(released\)/u);
});

test('clause 1: a run that landed or reopened items while others wait starts the next batch within seconds [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

test('a landing attempt waits out a busy board lock with backoff, and any other refusal still ends it [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, async () => {});

test('a BOARD_BUSY on one write mid-batch retries only that write and never redoes the batch [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, async () => {});

test('progress always wins over a deferral; with nothing moved the deferral stands [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});

test('clause 2: a deferral schedules no wake when nothing waits, whether the run moved work or not [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});
