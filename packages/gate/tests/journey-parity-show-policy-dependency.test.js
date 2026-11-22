/** @pullboard-test-input apps/cli/tests/io/commands/show/dependency.test.js */
/** @pullboard-world-pin: clause 2 reads the journey source to count its cases. */
/**
 * The parity check for the show/policy/dependency journey (U149): its one case runs twice, once with every journey CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its own
 * budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/tests/io/commands/show/dependency.test.js', cases: ["clause 2: a dependency's own verified dependency admits its files [N16,V4]"] }];

test('gate.journey-parity-show-policy-dependency.a-sample-of-the-show-policy-dependency: clause 1: a sample of the show/policy/dependency journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-show-policy-dependency.ignores-only-stage-mark-detail-time: clause 2: parity ignores only a valid stage mark detail time while preserving event time and every other at field [C7]', () => {
  const eventAt = '2026-11-21T23:00:00.000Z';
  const row = { args: ['show', '--json'], code: 0, json: { thread: [{ type: 'move', kind: 'mark', at: eventAt,
    detail: { stage: 'seat-ready', edge: 'point', reason: null, ref: 'abc', at: 1_700_000_000_000 } }] }, out: null, err: '', board: { items: [], events: [] } };
  const changedDetailTime = structuredClone(row);
  changedDetailTime.json.thread[0].detail.at += 1;
  assert.ok(Number.isFinite(Date.parse(row.json.thread[0].at)), 'the event timestamp metadata is a valid timestamp');
  assert.deepEqual(parityDifferences([row], [changedDetailTime]), [], 'only the independent stage mark detail time is ignored');
  assert.match(parityDifferences([row], [{ ...row, at: `${eventAt}!` }]).join('\n'), /json differs/u, 'a top-level at difference still fails');
  const changedEventTime = structuredClone(row);
  changedEventTime.json.thread[0].at = '2026-11-21T23:00:00.001Z';
  assert.match(parityDifferences([row], [changedEventTime]).join('\n'), /json differs/u, 'the event timestamp remains compared');
  const changedOtherAt = structuredClone(row);
  changedOtherAt.json.thread[0].detail.other = { at: 1_700_000_000_001 };
  assert.match(parityDifferences([row], [changedOtherAt]).join('\n'), /json differs/u, 'an unrelated nested at difference still fails');
  const changedStage = structuredClone(row);
  changedStage.json.thread[0].detail.stage = 'other';
  assert.match(parityDifferences([row], [changedStage]).join('\n'), /json differs/u, 'stage remains compared');
  const changedEdge = structuredClone(row);
  changedEdge.json.thread[0].detail.edge = 'other';
  assert.match(parityDifferences([row], [changedEdge]).join('\n'), /json differs/u, 'edge remains compared');
  const invalidMarkTime = structuredClone(row);
  invalidMarkTime.json.thread[0].detail.at = 'not-a-timestamp';
  assert.match(parityDifferences([row], [invalidMarkTime]).join('\n'), /json differs/u, 'an invalid mark time is not ignored');
});

test('gate.journey-parity-show-policy-dependency.the-show-policy-dependency-journey-keeps-all: clause 2: the show/policy/dependency journey keeps all 1 of its cases, and the sampled case is that one [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/io/commands/show/dependency.test.js', import.meta.url), 'utf8');
  // A title may hold an escaped quote and carry a stable-ID prefix (`area.file.slug: `): read the literal whole, then drop the prefix.
  const cases = [...source.matchAll(/^test\((["'`])((?:\\.|(?!\1).)*)\1/gmu)]
    .map(match => match[2].replace(/\\(.)/gu, '$1').replace(/^[a-z][\w-]*(?:\.[\w-]+)+: /u, ''));
  assert.equal(cases.length, 1, `the journey keeps its 1 case, found ${cases.length}`);
  assert.deepEqual(cases, SAMPLES[0].cases);
});
