/** @pullboard-test-input source-cell packages/seats */
/** Seat runtime profiles end to end: shipped data, the seat launch configuration and the recorded cached/fresh split [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { seatLaunchConfig } from '../../../../packages/seats/index.js';
import { recordCoordinatorUsage } from '../../../../packages/stats/index.js';
import { sumUsage } from '../../../../packages/stats/index.js';
import { FIXTURE_MODEL } from '../../../../packages/gate/tests/fixtures/testkit.js';

const SEATS = new URL('../../../../packages/seats/src/', import.meta.url);
const PROFILES = JSON.parse(readFileSync(new URL('io/runtime-profiles.json', SEATS), 'utf8'));
const LANE_TOOLS = ['Read', 'Edit', 'Bash'];

/** A real in-memory board_meta table behind the native ports the usage recorder uses. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)');
  return { db, nativePorts: { atomic: (_board, run) => run(), logEvent: () => {} } };
}

/** Record one session's usage row, then read the stored records back. */
function stored(session, row) {
  const b = board();
  recordCoordinatorUsage(b, { session, records: [row], observedAt: 1 });
  return JSON.parse(b.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`coordinator:${session}`).meta_value).records;
}

const BASE = { model: FIXTURE_MODEL, inputTokens: 9, outputTokens: 4, wallMs: 0, knownInputTokens: 9, knownOutputTokens: 4, unknownReasons: [] };

test('settings.seat-runtime-profiles.shipped-profiles: clause 1: Claude has the first shipped profile with a 1-hour cache, and no provider name is hard-coded outside the shipped profiles [C7]', () => {
  assert.equal(PROFILES.claude.cache, '1h');
  assert.deepEqual(PROFILES.claude.cachedPrefix, ['instructions', 'skills', 'brief']);
  assert.equal(PROFILES.claude.toolLoading, 'per-lane');
  assert.equal(PROFILES.default.cache, 'off');
  const sources = readdirSync(new URL('io/', SEATS)).filter(name => name.endsWith('.js'));
  for (const name of sources) {
    const text = readFileSync(new URL(`io/${name}`, SEATS), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(text, /['"]claude['"]/, `${name} hard-codes a provider name`);
  }
});

test('settings.seat-runtime-profiles.launch-applies-profile: clause 2: a Claude seat launches with the 1-hour cache and its lane tools, a self-hosted seat with caching off and the same tools [C7]', () => {
  const claude = seatLaunchConfig({ runtime: 'claude', laneTools: LANE_TOOLS });
  assert.equal(claude.promptCache, '1h');
  assert.deepEqual(claude.cachedPrefix, ['instructions', 'skills', 'brief']);
  assert.deepEqual(claude.tools, LANE_TOOLS);
  const selfHosted = seatLaunchConfig({ runtime: 'self-hosted-llm', laneTools: LANE_TOOLS });
  assert.equal(selfHosted.promptCache, 'off');
  assert.deepEqual(selfHosted.cachedPrefix, []);
  assert.deepEqual(selfHosted.tools, LANE_TOOLS);
});

test('settings.seat-runtime-profiles.cached-versus-fresh: clause 3: the board records cached versus fresh input where the provider reports it, and not reported where it does not [C7]', () => {
  const [reported] = stored('s-reported', { ...BASE, freshInputTokens: 2, cacheReadInputTokens: 5, cacheWriteInputTokens: 2 });
  assert.deepEqual([reported.freshInputTokens, reported.cacheReadInputTokens, reported.cacheWriteInputTokens], [2, 5, 2]);
  const [silent] = stored('s-silent', BASE);
  assert.equal('freshInputTokens' in silent, false);
  const total = sumUsage([silent], {});
  assert.deepEqual([total.freshInputTokens, total.cacheReadInputTokens, total.cacheWriteInputTokens], [null, null, null]);
});
