/** A seat wrapper's fixed session id still yields real tokens when it names its transcript, and a visible reason when it does not [N2]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../../../gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { usageCheckpoint } from '../../../src/io/cost/ledger.js';
import { sessionSource } from '../../../src/io/cost/session.js';

const START = Date.parse('2026-11-09T12:00:00.000Z');
const MINUTE = 60_000;

/** One Claude assistant row whose usage the provider reader sums, stamped at an offset from the claim. */
function message(id, offset, usage) {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(START + offset).toISOString(), message: { id, model: FIXTURE_MODEL, usage } }) + '\n';
}

/** A private folder holding a wrapper-style environment: a fixed id that names no file, and an empty Claude config. */
function fixture(t) {
  const scratch = privateFixtureFiles('pullboard-wrapper-session-');
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));
  const dir = scratch.root;
  const config = join(dir, 'claude');
  mkdirSync(join(config, 'projects'), { recursive: true });
  const commonDir = join(dir, 'common');
  mkdirSync(commonDir);
  const environment = { CLAUDE_CODE_SESSION_ID: 'studio-seat-fixed', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: config };
  return { dir, commonDir, environment };
}

/** A fresh private ledger folder, so each case starts with no earlier anchor. */
let ledgers = 0;
function ledger(run) {
  const directory = join(run.dir, `ledger-${++ledgers}`);
  mkdirSync(directory);
  return directory;
}

/** Claim at START, then close five minutes on, and return the numeric record the close would publish. */
function claimThenRelease({ commonDir, environment }, append) {
  const interval = { key: 'claim-7', item: 7, start: START, end: null };
  usageCheckpoint({ commonDir }, { agent: 'fixture-agent', item: 7, operation: 'claim', model: FIXTURE_MODEL, now: START, environment, newClaim: true, intervals: [interval] });
  append?.();
  const changes = usageCheckpoint({ commonDir }, { agent: 'fixture-agent', item: 7, operation: 'release', model: FIXTURE_MODEL, now: START + 5 * MINUTE, environment,
    intervals: [{ ...interval, end: START + 5 * MINUTE }] });
  return changes.items.find((value) => value.item === 7).records[0];
}

test('stats.session.a-fixed-session-id-with-pullboard: a fixed session id with PULLBOARD_SESSION_LOG records the transcript tokens [N2]', (t) => {
  const run = fixture(t);
  const log = join(run.dir, 'wrapper-transcript.jsonl');
  writeFileSync(log, message('before', -MINUTE, { input_tokens: 900, output_tokens: 90 }));
  run.environment.PULLBOARD_SESSION_LOG = log;
  const record = claimThenRelease(run, () => writeFileSync(log, message('before', -MINUTE, { input_tokens: 900, output_tokens: 90 })
    + message('work', 2 * MINUTE, { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 })));
  assert.equal(record.inputTokens, 250);
  assert.equal(record.outputTokens, 7);
  assert.deepEqual(record.unknownReasons, []);
});

test('stats.session.pullboard-session-dir-names-the-newest: PULLBOARD_SESSION_DIR names the newest transcript in that folder [N2]', (t) => {
  const run = fixture(t);
  const folder = join(run.dir, 'project');
  mkdirSync(folder);
  const older = join(folder, 'older.jsonl'), newer = join(folder, 'newer.jsonl');
  writeFileSync(older, message('old', -MINUTE, { input_tokens: 1, output_tokens: 1 }));
  writeFileSync(newer, message('before', -MINUTE, { input_tokens: 5, output_tokens: 1 }));
  utimesSync(older, new Date(START - 60 * MINUTE), new Date(START - 60 * MINUTE));
  utimesSync(newer, new Date(START), new Date(START));
  run.environment.PULLBOARD_SESSION_DIR = folder;
  assert.equal(sessionSource(run.environment).file, newer);
  const record = claimThenRelease(run, () => writeFileSync(newer, message('before', -MINUTE, { input_tokens: 5, output_tokens: 1 })
    + message('work', MINUTE, { input_tokens: 30, output_tokens: 4 })));
  assert.equal(record.inputTokens, 30);
  assert.equal(record.outputTokens, 4);
});

test('stats.session.a-declared-transcript-wins-over-the: a declared transcript wins over the session id lookup [N2]', (t) => {
  const run = fixture(t);
  const projects = join(run.environment.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
  mkdirSync(projects);
  writeFileSync(join(projects, 'studio-seat-fixed.jsonl'), message('by-id', -MINUTE, { input_tokens: 1, output_tokens: 1 }));
  const log = join(run.dir, 'declared.jsonl');
  writeFileSync(log, message('declared', -MINUTE, { input_tokens: 2, output_tokens: 1 }));
  assert.equal(sessionSource({ ...run.environment, PULLBOARD_SESSION_LOG: log }).file, log);
  assert.equal(sessionSource(run.environment).file, join(projects, 'studio-seat-fixed.jsonl'));
});

test('stats.session.without-a-resolvable-transcript-the-recorded: without a resolvable transcript the recorded reason is wrapper-session-id-fixed [N2]', (t) => {
  const run = fixture(t);
  assert.equal(sessionSource(run.environment), null);
  for (const declared of [{}, { PULLBOARD_SESSION_LOG: join(run.dir, 'missing.jsonl') }, { PULLBOARD_SESSION_DIR: join(run.dir, 'missing') }, { PULLBOARD_SESSION_LOG: 'relative.jsonl' }]) {
    const record = claimThenRelease({ ...run, environment: { ...run.environment, ...declared }, commonDir: ledger(run) });
    assert.equal(record.inputTokens, null);
    assert.equal(record.outputTokens, null);
    assert.deepEqual(record.unknownReasons, ['wrapper-session-id-fixed']);
  }
});
