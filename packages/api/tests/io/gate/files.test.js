/** The gate fact's file comparison words a file absent on main as the item's own red, and a missing receipt with its job and next step [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { compareFilesWithMain } from '../../../src/io/gate/files.js';
import { fileMainLines } from '../../../src/io/gate/files.js';

const MAIN = 'a'.repeat(40);
const row = (file, over = {}) => ({ file, result: null, receipt: null, job: null, absentOnMain: false, ...over });

test('api.gate-files.new-file-absent-on-main: clause 1: fileMainLines for a row with result null and absentOnMain true says the file is new in this item and its red is the item\'s own, with no main receipt missing line [C7]', () => {
  const lines = fileMainLines({}, { main: MAIN, jobs: [], files: [row('tests/new.test.js', { absentOnMain: true })] });
  assert.deepEqual(lines, ['not on main: tests/new.test.js is new in this item; the red is the item\'s own, fix the test or the code, do not resubmit unchanged']);
  assert.ok(!lines.some(line => line.includes('main receipt missing')));
});

test('api.gate-files.missing-receipt-names-job-and-next: clause 2: a null-result row for a file present on main with job job-1 says main receipt missing, names main-test job job-1 and says to wait for it, not to resubmit [C7]', () => {
  const [line, ...rest] = fileMainLines({}, { main: MAIN, jobs: ['job-1'], files: [row('tests/old.test.js', { job: 'job-1' })] });
  assert.equal(rest.length, 0);
  assert.match(line, /^main receipt missing: tests\/old\.test\.js/u);
  assert.match(line, /main-test job job-1/u);
  assert.match(line, /wait for that job, do not resubmit/u);
});

test('api.gate-files.compare-marks-absent-on-main: clause 3: compareFilesWithMain against a real git fixture marks a failing file not on main with absentOnMain true and a file on main with false [C7]', t => {
  const repo = cellRepo(t, { real: true, config: { affectedTests: 'node --test' } });
  repo.put('tests/old.test.js', 'x\n');
  const main = repo.commitAll();
  const receipt = { gate: { phases: [{ status: 1, failedFiles: ['tests/old.test.js', 'tests/new.test.js'] }] } };
  const lookup = ({ files }) => ({ files: files.map(file => ({ file, result: null, receipt: null, job: 'job-1' })) });
  const compared = compareFilesWithMain({ gitRoot: repo.root, db: null }, receipt, main, lookup);
  assert.equal(compared.unavailable, undefined);
  assert.deepEqual(compared.files.map(found => [found.file, found.absentOnMain]), [['tests/old.test.js', false], ['tests/new.test.js', true]]);
});
