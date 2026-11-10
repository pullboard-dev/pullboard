import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { test } from 'node:test';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

test('accept reuses sealed submit receipts when clean plan derivation is unavailable [C7]', { timeout: 180000 }, async t => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'receipt-reuse-builder';
  sandbox.env.CODEX_THREAD_ID = 'receipt-reuse-builder-session';
  const checkCount = join(sandbox.dir, 'check-count');
  const gateCount = join(sandbox.dir, 'gate-count');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const box = helpers.project(`printf x >> ${quote(gateCount)}`, sandbox);
  const check = `printf x >> ${quote(checkCount)}`;
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Receipt plan fallback', criterion: 'the check passes', check, args: ['--specs', 'G1'] });
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const committed = helpers.commitFile(box, box.web, 'web/proof.js', 'export const proof = true;\n', 'feat(web): add proof fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const checkAfterSubmit = readFileSync(checkCount, 'utf8');
  const gateAfterSubmit = readFileSync(gateCount, 'utf8');

  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  sandbox.env.CODEX_THREAD_ID = 'receipt-reuse-reviewer-session';
  const joined = fixtureJoin(box.run, reviewer, 'web', '--model', 'receipt-reuse-reviewer');
  assert.equal(joined.code, 0, joined.err || joined.out);
  // This leaves the reviewed commit unchanged while making clean-plan derivation unavailable.
  writeFileSync(join(reviewer, 'reviewer-note.tmp'), 'uncommitted reviewer-local note');

  const started = performance.now();
  const verdict = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The submitted source and its sealed proof match.');
  const elapsed = performance.now() - started;
  assert.equal(verdict.code, 0, verdict.err || verdict.out);
  assert.match(verdict.out, /reused submit proof [a-f0-9-]{36}/);
  assert.equal(readFileSync(checkCount, 'utf8'), checkAfterSubmit, 'the frozen check did not run again');
  assert.equal(readFileSync(gateCount, 'utf8'), gateAfterSubmit, 'the proof command did not run again');
  assert.ok(elapsed < 5000, `accept took ${Math.round(elapsed)} ms`); // budget: declared #2845 requires green accept under 5000 ms.
});
