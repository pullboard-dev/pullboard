import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { reusableSubmitProof, sealedMoveOverlap, submittedPolicyCommit } from '../packages/verify/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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
  const { submitReusePlanDigest } = await import('../packages/verify/src/core/submit-reuse-plan.js');
  PLAN = submitReusePlanDigest({ check: 'node --test test/a.test.js', files: ['test/a.test.js'], full: false, deferred: true, proofCommand: "node --test './test/a.test.js'" });
  const events = sealedEvents({ deferred: true });
  const args = { item: { item_id: 7, item_frozen_digest: 'd1' }, commit: 'c1', tree: 't1', main: 'm1', check: 'node --test test/a.test.js', affectedTests: 'node --test', gate: '', supplement: '' };
  assert.equal(submittedPolicyCommit(events), 'm1');
  assert.match(reusableSubmitProof(events, args).reason, /incomplete/, 'a deferred proof alone is still refused with its reason');
  const reused = reusableSubmitProof(events, { ...args, allowDeferred: true });
  assert.deepEqual(reused.ids, ['criterion', 'proof']);
});

test('a moved main keeps the receipt unless it changes the item or its check [C7]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-fast-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'a@b.c'); git(dir, 'config', 'user.name', 'T');
  const commit = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', `change ${path}`); return git(dir, 'rev-parse', 'HEAD'); };
  const base = commit('base.txt', 'base');
  git(dir, 'switch', '-qc', 'item');
  const item = commit('item.js', 'x');
  git(dir, 'switch', '-q', 'main');
  assert.equal(sealedMoveOverlap(dir, { from: base, to: base, commit: item, check: 'node --test test/a.test.js' }), null);
  const unrelated = commit('other.txt', 'y');
  assert.equal(sealedMoveOverlap(dir, { from: base, to: unrelated, commit: item, check: 'node --test test/a.test.js' }), null);
  const named = commit('test/a.test.js', 'z');
  assert.match(sealedMoveOverlap(dir, { from: base, to: named, commit: item, check: 'node --test test/a.test.js' }), /test\/a\.test\.js, a file the check names/);
  const touched = commit('item.js', 'w');
  assert.match(sealedMoveOverlap(dir, { from: base, to: touched, commit: item, check: 'node --test x' }), /item\.js, a file this item changed/);
  assert.match(sealedMoveOverlap(dir, { from: touched, to: base, commit: item, check: 'x' }), /rewound/);
});

test('accept reuses the receipt after an unrelated landing moved main [C7]', { timeout: 180000 }, async t => {
  const { createE2eHelpers } = await import('./e2e-helpers.js');
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'fast-builder'; sandbox.env.CODEX_THREAD_ID = 'fast-builder-session';
  const count = join(sandbox.dir, 'check-count');
  const box = helpers.project('true', sandbox);
  const added = box.run(box.repo, 'add', 'web', 'Fast accept', '--specs', 'G1', '--criterion', 'the check passes', '--check', `printf x >> '${count}'`, '--brief', 'Files:\n- web/proof.js\nTest:\n- the check passes\n');
  assert.equal(added.code, 0, added.err || added.out);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/proof.js', 'export const proof = true;\n', 'feat(web): add proof fixture [G1]').status, 0);
  const submitted = box.run(box.web, 'submit', '1');
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const before = readFileSync(count, 'utf8');
  const landed = helpers.commitFile(box, box.repo, 'unrelated.txt', 'landed elsewhere\n', 'chore: unrelated landing');
  assert.equal(landed.status, 0, landed.stderr || landed.stdout);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, box.git(box.web, 'rev-parse', 'HEAD'));
  sandbox.env.CODEX_THREAD_ID = 'fast-reviewer-session';
  assert.equal(box.run(reviewer, 'join', 'web', '--model', 'fast-reviewer').code, 0);
  const started = performance.now();
  const verdict = box.run(reviewer, 'verify', '1', 'accept', '--note', 'The sealed receipt covers the check.');
  const elapsed = performance.now() - started;
  assert.equal(verdict.code, 0, verdict.err || verdict.out);
  assert.match(verdict.out, /reused submit proof/);
  assert.equal(readFileSync(count, 'utf8'), before, 'the frozen check did not run again');
  assert.ok(elapsed < 15000, `accept took ${Math.round(elapsed)} ms`); // budget: declared #2939 requires green accept under 15000 ms.
});
