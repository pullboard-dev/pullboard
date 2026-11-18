/** @pullboard-test-input apps/view/src/logic/needs/summary.js apps/view/src/logic/resume.js */
/** @pullboard-world-pin reads the two summary sources to prove neither imports the person package. */
/** The needs summary takes an injected passkey decision, and only the io wrappers bind the person's [N26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../../../../../../packages/config/index.js';
import { cellBoard } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { personNeedsSummary } from '../../../../index.js';
import { resumeNeeds } from '../../../../index.js';
import { personNeedsSummaryWith } from '../../../../src/logic/needs/summary.js';
import { resumeNeedsWith } from '../../../../src/logic/resume.js';
import { personNeedsSummary as boundSummary } from '../../../../src/io/needs.js';
import { resumeNeeds as boundResume } from '../../../../src/io/needs.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('view.needs-summary-with.clause-1-neither-logic-file-imports-the: clause 1: neither logic file imports the person package [N26]', () => {
  for (const file of ['../../../../src/logic/needs/summary.js', '../../../../src/logic/resume.js']) {
    assert.doesNotMatch(source(file), /from ['"][^'"]*packages\/person\//u, file);
    assert.doesNotMatch(source(file), /verifiedPasskeyRowDecision\s*\}\s*from/u, file);
  }
});

test('view.needs-summary-with.clause-1-the-summary-and-resume-take: clause 1: the summary and resume take the passkey decision as an argument [N26]', t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const config = loadConfig(repo.root);
  const decision = () => false;
  const summary = personNeedsSummaryWith(repo.root, { board, config }, decision);
  assert.ok(Array.isArray(summary.needs));
  const resume = resumeNeedsWith(repo.root, { board, config }, decision);
  assert.ok(Array.isArray(resume.needs));
});

test('view.needs-summary-with.clause-1-the-person-bound-wrappers-live: clause 1: the person-bound wrappers live in io/needs.js and index.js re-exports the same names [N26]', t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const config = loadConfig(repo.root);
  assert.equal(personNeedsSummary, boundSummary);
  assert.equal(resumeNeeds, boundResume);
  assert.deepEqual(boundSummary(repo.root, { board, config }), personNeedsSummaryWith(repo.root, { board, config }, () => false));
  assert.deepEqual(boundResume(repo.root, { board, config }), resumeNeedsWith(repo.root, { board, config }, () => false));
});
