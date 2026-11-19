/** @pullboard-test-input source-cell apps/cli */
/** The accept record of an item submitted through the seam equals a literal captured once from an item submitted through a real pulled gate [C7,#9874]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seamSubmittedItem } from './submitted-seam.js';
import { clean } from './verdict-check.js';
import { project } from './verdict-check.js';
import { sandbox } from './verdict-check.js';
import { succeeds } from './verdict-check.js';

/** Keys whose values differ on every run: ids, times, commits, heads, digests and the trunk or paths a review names. */
const VARYING = /^(id|item_id|verdict_id|verdict_at|verdict_commit|verdict_head|verdict_digest|commit|head|trunk|paths)$/u;

/** A value with every varying key removed, at any depth, and keys sorted. */
function steady(value) {
  if (Array.isArray(value)) return value.map(steady);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !VARYING.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, steady(inner)]));
}

/** The model name the fixture seat recorded in the captured accept. */
const CAPTURED_MODEL = 'claude-opus-fixture';

/** The reference record captured once on a runner: the accept an item leaves after a real pulled gate, run 848cca61 of the first case of this file's earlier form. */
const REAL_GATE_RECORD = {
  status: null,
  verdict: {
    assurance: 'procedural',
    check: 'none',
    environment: null,
    review: {},
    verdict_by: 'coordinator',
    verdict_decision: 'ACCEPT',
    verdict_note: 'checked the submitted work',
    verdict_reason: 'CRITERION_MET',
    verdict_verifier_family: null,
  },
  detail: {
    check: 'none',
    environment: null,
    model: CAPTURED_MODEL,
    note: 'checked the submitted work',
    reason: 'CRITERION_MET',
    review: {},
  },
  detailKeys: ['check', 'commit', 'environment', 'model', 'note', 'reason', 'review'],
};

test('cli.tests-fixtures-submitted-seam-accept.accept-record-equals-a-real-gate: clause 2: the accept record of the seam item equals the literal captured from a real pulled gate [C7,#9874]', async () => {
  const box = sandbox();
  try {
    const { repo, web } = await project(box);
    const id = await seamSubmittedItem(box, repo, web);
    await succeeds(box, repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the submitted work');
    const shown = JSON.parse(await succeeds(box, repo, 'show', String(id), '--json'));
    const event = JSON.parse(await succeeds(box, repo, 'log', String(id), '--json')).events.find(row => row.event_kind === 'accept');
    const detail = JSON.parse(event.event_detail);
    const record = { status: shown.status ?? shown.item?.item_status ?? null, verdict: steady(shown.verdicts.at(-1)), detail: steady(detail), detailKeys: Object.keys(detail).sort() };
    assert.deepEqual(record, REAL_GATE_RECORD);
  } finally { clean(box); }
});
