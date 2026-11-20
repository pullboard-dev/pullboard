/** Submit records a base-commit run of each [test] clause's named file, so the fail-before check has data [C7,#8090]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseReceiptProblem } from '../../../../../packages/state/index.js';
import { recordClauseBaseRuns } from '../../../src/io/submit/clause-base.js';

const FILE = 'packages/x/tests/a.test.js', OTHER = 'packages/x/tests/b.test.js';
const BASE = 'b'.repeat(40);
const item = { item_id: 9, item_claim_head: BASE, item_criterion: `1. The thing holds in ${FILE} [test]. 2. And in ${OTHER} [test]. 3. A command runs [command].`, item_brief: '' };
const gateFiles = new Set([FILE, OTHER]);

/** A stand-in base comparison that records each file it is asked to run at which commit and keeps its receipt id. */
function comparison() {
  const asked = [];
  const compare = async (root, profile, onWait, output, options) => {
    for (const row of profile.tests) asked.push([row.file, options.commit]);
    for (const row of profile.tests) await options.onMeasuredReceipt?.(`receipt-${row.file}`);
    return { main: options.commit, files: profile.tests.map(row => ({ file: row.file, result: 'red' })) };
  };
  return { asked, compare };
}

test('cli.io-submit-clause-base.each-test-clause-file-runs-at-the: clause 1: each [test] clause file runs at the item base and its receipt is recorded [C7]', async () => {
  const { asked, compare } = comparison();
  const recorded = [];
  const result = await recordClauseBaseRuns('/repo', item, { gateFiles, recordedRows: [], record: async id => { recorded.push(id); } }, { compare, exists: () => true });
  assert.deepEqual(asked, [[FILE, BASE], [OTHER, BASE]]);
  assert.deepEqual(recorded, [`receipt-${FILE}`, `receipt-${OTHER}`]);
  assert.deepEqual(result, { ran: [FILE, OTHER], skipped: [] });
});

test('cli.io-submit-clause-base.a-file-with-a-recorded-base-run: clause 1: a file with a recorded base run is not run again, and a file the base lacks is skipped with its reason [C7]', async () => {
  const { asked, compare } = comparison();
  const result = await recordClauseBaseRuns('/repo', item, { gateFiles, recordedRows: [{ file: FILE, name: 'x' }] }, { compare, exists: () => false });
  assert.deepEqual(asked, []);
  assert.deepEqual(result.ran, []);
  assert.deepEqual(result.skipped.map(row => row.file), [OTHER]);
  const none = await recordClauseBaseRuns('/repo', { ...item, item_claim_head: null }, { gateFiles, recordedRows: [] }, { compare, exists: () => true });
  assert.deepEqual(none, { ran: [], skipped: [] }, 'no base commit, no run');
});

test('cli.io-submit-clause-base.an-unavailable-or-throwing-comparison-is-reported: clause 1: an unavailable or throwing comparison is reported as skipped and never thrown [C7]', async () => {
  const unavailable = await recordClauseBaseRuns('/repo', item, { gateFiles, recordedRows: [] }, { compare: async () => ({ unavailable: 'no runner' }), exists: () => true });
  assert.deepEqual(unavailable.skipped.map(row => row.reason), ['no runner', 'no runner']);
  const thrown = await recordClauseBaseRuns('/repo', item, { gateFiles, recordedRows: [] }, { compare: async () => { throw new Error('boom'); }, exists: () => true });
  assert.deepEqual(thrown.skipped.map(row => row.reason), ['boom', 'boom']);
});

test('cli.io-submit-clause-base.a-test-that-fails-on-an-assertion: clause 2: a test that fails on an assertion at base and passes at head passes the fail-before check [C7]', () => {
  const baseRows = [FILE, OTHER].map(file => ({ file, name: 'x', passed: false, skipped: false, failure: 'assertion' }));
  assert.equal(clauseReceiptProblem(item, { gateFiles, baseRows, baseCommit: BASE }), null);
  assert.match(clauseReceiptProblem(item, { gateFiles, baseRows: [], baseCommit: BASE })?.message ?? '', /no recorded run that fails on an assertion/u);
});
