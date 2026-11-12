import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  FIXTURE_MODEL,
  FIXTURE_MODEL_EARLIER,
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';
import {
  reusableSubmitProof,
  sealedMoveOverlap,
  submittedPolicyCommit,
} from '../../../../../packages/verify/index.js';

/** A submit event plus the admission and both receipts, shaped as the board records them. */
function sealedEvents({ deferred }) {
  const detail = { commit: 'c1', tree: 't1', policyCommit: 'm1', criterionDigest: 'd1', gateGreen: true,
    submissionProof: { files: ['test/a.test.js'], full: false, deferred } };
  const run = (phase, command) => ({ event_id: phase === 'criterion' ? 3 : 4, event_by: 'b', event_kind: 'proof-run', event_detail: JSON.stringify({ receipt: {
    id: phase, kind: 'submit', item: 7, seat: 'b', commit: 'c1', tree: 't1', main: 'm1', frozenDigest: 'd1', submitPhase: phase, submitAdmission: 'adm',
    submitReuse: true, submitReusePlan: PLAN, sourceClean: true, green: true, exitCode: 0, command } }) });
  return [
    { event_id: 1, event_by: 'b', event_kind: 'claim', event_detail: JSON.stringify({ submitAdmission: { id: 'adm', commit: 'c1', tree: 't1' } }) },
    run('criterion', sha('node --test test/a.test.js')), run('proof', sha("node --test './test/a.test.js'")),
    { event_id: 5, event_by: 'b', event_kind: 'submit', event_detail: JSON.stringify(detail) },
  ];
}
let PLAN = '';
const sha = text => execFileSync('node', ['-e', `process.stdout.write(require('crypto').createHash('sha256').update(${JSON.stringify(text)}).digest('hex'))`], { encoding: 'utf8' });

test('a deferred full suite no longer blocks reusing the sealed receipts [C7]', async () => {
  const { submitReusePlanDigest } = await import('../../../../../packages/verify/src/logic/plan.js');
  PLAN = submitReusePlanDigest({ check: 'node --test test/a.test.js', files: ['test/a.test.js'], full: false, deferred: true, proofCommand: "node --test './test/a.test.js'" });
  const events = sealedEvents({ deferred: true });
  const args = { item: { item_id: 7, item_frozen_digest: 'd1' }, commit: 'c1', tree: 't1', main: 'm1', check: 'node --test test/a.test.js', affectedTests: 'node --test', gate: '', supplement: '' };
  assert.equal(submittedPolicyCommit(events), 'm1');
  assert.match(reusableSubmitProof(events, args).reason, /incomplete/, 'a deferred proof alone is still refused with its reason');
  const reused = reusableSubmitProof(events, { ...args, allowDeferred: true });
  assert.deepEqual(reused.ids, ['criterion', 'proof']);
});

test('a moved main keeps the receipt unless it changes the item or its check [C7]', async t => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox());
  const dir = box.repo;
  const commit = (path, text) => { helpers.commitFile(box, dir, path, text, `chore: change ${path}`); return box.git(dir, 'rev-parse', 'HEAD'); };
  const base = commit('base.txt', 'base');
  box.git(dir, 'switch', '-qc', 'item');
  const item = commit('item.js', 'x');
  box.git(dir, 'switch', '-q', 'main');
  assert.equal(sealedMoveOverlap(dir, { from: base, to: base, commit: item, check: 'node --test test/a.test.js' }), null);
  const unrelated = commit('other.txt', 'y');
  assert.equal(sealedMoveOverlap(dir, { from: base, to: unrelated, commit: item, check: 'node --test test/a.test.js' }), null);
  const named = commit('test/a.test.js', 'z');
  assert.match(sealedMoveOverlap(dir, { from: base, to: named, commit: item, check: 'node --test test/a.test.js' }), /test\/a\.test\.js, a file the check names/);
  const spaced = commit('test/a space.test.js', 'q');
  assert.match(sealedMoveOverlap(dir, { from: named, to: spaced, commit: item, check: "node --test 'test/a space.test.js'" }), /test\/a space\.test\.js, a file the check names/);
  const touched = commit('item.js', 'w');
  assert.match(sealedMoveOverlap(dir, { from: base, to: touched, commit: item, check: 'node --test x' }), /item\.js, a file this item changed/);
  assert.match(sealedMoveOverlap(dir, { from: touched, to: base, commit: item, check: 'x' }), /rewound/);
});

test('clause 1: accept reuses the receipt after an unrelated landing moved main [C7]', { timeout: 180000 }, async t => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = FIXTURE_MODEL; sandbox.env.CODEX_THREAD_ID = 'fast-builder-session';
  const count = join(sandbox.dir, 'check-count');
  const box = helpers.project('true', sandbox);
  const added = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Fast accept', criterion: 'the check passes', check: `printf x >> '${count}'`, brief: 'Files:\n- web/proof.js\nTest:\n- the check passes\n', args: ['--specs', 'G1'], diagnose: false });
  const id = String(added.item_id);
  assert.equal((await box.runIn(box.web, 'claim', id)).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/proof.js', 'export const proof = true;\n', 'feat(web): add proof fixture [G1]').status, 0);
  const submitted = await box.runIn(box.web, 'submit', id);
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const before = readFileSync(count, 'utf8');
  const landed = helpers.commitFile(box, box.repo, 'unrelated.txt', 'landed elsewhere\n', 'chore: unrelated landing');
  assert.equal(landed.status, 0, landed.stderr || landed.stdout);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  sandbox.env.CODEX_THREAD_ID = 'fast-reviewer-session';
  assert.equal(joinFixtureSeat(box, reviewer, 'web', { model: FIXTURE_MODEL_EARLIER }).code, 0);
  const started = performance.now();
  const verdict = await box.runIn(reviewer, 'verify', id, 'accept', '--note', 'The sealed receipt covers the check.');
  const elapsed = performance.now() - started;
  assert.equal(verdict.code, 0, verdict.err || verdict.out);
  assert.match(verdict.out, /reused submit proof/);
  assert.equal(readFileSync(count, 'utf8'), before, 'the frozen check did not run again');
  assert.ok(elapsed < 15000, `accept took ${Math.round(elapsed)} ms`); // budget: declared #2939 requires green accept under 15000 ms.
});

test('clause 2: accept says why the receipt could not be reused before it reruns the check [C7]', { timeout: 180000 }, async t => {
  const { createE2eHelpers } = await import('../../../tests/fixtures/e2e.js');
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = FIXTURE_MODEL; sandbox.env.CODEX_THREAD_ID = 'fast-builder-session';
  const count = join(sandbox.dir, 'check-count');
  const box = helpers.project('true', sandbox);
  const added = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Fast accept', criterion: 'the check passes', check: `test -n web/dep.js && printf x >> '${count}'`, brief: 'Files:\n- web/proof.js\nTest:\n- the check passes\n', args: ['--specs', 'G1'], diagnose: false });
  const id = String(added.item_id);
  assert.equal((await box.runIn(box.web, 'claim', id)).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/proof.js', 'export const proof = true;\n', 'feat(web): add proof fixture [G1]').status, 0);
  const submitted = await box.runIn(box.web, 'submit', id);
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const landed = helpers.commitFile(box, box.repo, 'web/dep.js', 'export const dep = 1;\n', 'feat(web): main adds a file the check names [G1]');
  assert.equal(landed.status, 0, landed.stderr || landed.stdout);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  sandbox.env.CODEX_THREAD_ID = 'fast-reviewer-session';
  assert.equal(joinFixtureSeat(box, reviewer, 'web', { model: FIXTURE_MODEL_EARLIER }).code, 0);
  const verdict = await box.runIn(reviewer, 'verify', id, 'accept', '--note', 'The sealed receipt covers the check.');
  const said = `${verdict.out}${verdict.err}`;
  assert.match(said, /submit proof not reused: .*main moved since submit and reaches web\/dep\.js, a file the check names/u, said);
});
