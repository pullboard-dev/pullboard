/** An accept names the exact landing step for its repo, and a dry run refuses a push the real land would refuse [I1,B3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Escape literal text, such as a sandbox path, for a regular expression. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The trailer paragraph a hand merge writes for an item citing G1, as the accept prints it [B3]. */
const trailerArg = (id) => `-m "$(printf '%s\\n' 'Pullboard-Item: #${id}' 'Pullboard-Rows: G1')"`;

/** File, build, submit and accept one web item through the real CLI and hooks, returning the accept output. */
function acceptedItem(box, file, { beforeVerify = () => {} } = {}) {
  const added = fixtureAdd(box.run, box.repo, 'web', `Write ${file}`, '--specs', 'G1', '--criterion', `${file} exists`, '--check', `test -f ${file}`, '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  const committed = commitFile(box, box.web, file, 'built\n', `feat(web): write ${file.split('/').pop()} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = box.run(box.web, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err);
  box.git(box.review, 'switch', '-q', '--detach', commit);
  beforeVerify();
  const verdict = box.run(box.review, 'verify', String(id), 'accept', '--note', 'the file exists at the submitted commit');
  assert.equal(verdict.code, 0, verdict.err);
  return { id, commit, out: verdict.out };
}

/** Add a reviewer in its own worktree, so the main checkout stays on main as it does for a real accept. */
function withReviewer(box) {
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', review, '-b', 'api/review');
  assert.equal(fixtureJoin(box.run, review, 'api', '--model', 'fixture-model', '--route', 'strong').code, 0);
  return { ...box, review };
}

/** Run one CLI command for its JSON refusal. */
function refusal(box, ...args) {
  const result = box.run(box.repo, ...args, '--json');
  assert.notEqual(result.code, 0, `${args.join(' ')} should refuse: ${result.out}`);
  return JSON.parse(result.out).error;
}

test('an accept says how to land, and a dry run catches a missing origin [I1,B3]', () => {
  const box = withReviewer(project());

  // Clause 1, repo without a remote: the accept prints the exact git merge command for this repo.
  const first = acceptedItem(box, 'web/first.txt');
  const merge = new RegExp(`^next: this repo has no remote for pullboard land to push to, so the coordinator merges it on main: (cd ${literal(box.repo)} && git merge --no-ff ${first.commit} -m 'feat\\(merge\\): write web/first\\.txt \\[G1\\]' ${literal(trailerArg(first.id))} && pullboard merged ${first.id} HEAD)$`, 'mu');
  const printed = merge.exec(first.out);
  assert.ok(printed, `the accept names the hand merge for a repo without origin:\n${first.out}`);

  // Clause 2: the dry run refuses LAND_PUSH, with exactly the refusal the real land gives.
  const dry = refusal(box, 'land', '--dry-run');
  assert.equal(dry.code, 'LAND_PUSH', JSON.stringify(dry));
  assert.match(dry.message, /the landing push failed: this repo has no origin remote to push main to; add one with git remote add origin <url>/u);
  const real = refusal(box, 'land');
  assert.deepEqual(real, dry, 'the real land refuses the same way, before it gates anything');

  // The printed command is exact: running it lands the item and records the merge.
  const ran = spawnSync('/bin/sh', ['-c', printed[1]], { cwd: box.dir, env: box.env, encoding: 'utf8' });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', first.commit, 'main').status, 0, 'main now carries the accepted commit');
  assert.equal(box.git(box.repo, 'log', '-1', '--format=%B', 'main'), `feat(merge): write web/first.txt [G1]\n\nPullboard-Item: #${first.id}\nPullboard-Rows: G1`,
    'the hand merge writes the generated header and the trailers as its last paragraph');
  const shown = JSON.parse(box.run(box.repo, 'show', String(first.id), '--json').out);
  assert.equal(shown.item_merged_commit, box.git(box.repo, 'rev-parse', 'main'));

  // Clause 1, repo with origin: the accept prints pullboard land, and the dry run previews it.
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const second = acceptedItem(box, 'web/second.txt');
  assert.match(second.out, new RegExp(`^next: the coordinator lands it: cd ${literal(box.repo)} && pullboard land$`, 'mu'));
  const preview = box.run(box.repo, 'land', '--dry-run', '--json');
  assert.equal(preview.code, 0, preview.out);
  assert.deepEqual(JSON.parse(preview.out).items, [second.id]);
});

test('an accept names the primary checkout when Git metadata is stored separately [I1,B3]', () => {
  const box = withReviewer(project(undefined, undefined, { separateGitDir: true }));
  const accepted = acceptedItem(box, 'web/separate.txt');
  const merge = new RegExp(`^next: this repo has no remote for pullboard land to push to, so the coordinator merges it on main: (cd ${literal(box.repo)} && git merge --no-ff ${accepted.commit} -m 'feat\\(merge\\): write web/separate\\.txt \\[G1\\]' ${literal(trailerArg(accepted.id))} && pullboard merged ${accepted.id} HEAD)$`, 'mu');
  const printed = merge.exec(accepted.out);
  assert.ok(printed, `the accept names the actual primary checkout for separate Git metadata:\n${accepted.out}`);

  const ran = spawnSync('/bin/sh', ['-c', printed[1]], { cwd: box.dir, env: box.env, encoding: 'utf8' });
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', accepted.commit, 'main').status, 0, 'the exact printed command lands the accepted commit');

  const unregistered = withReviewer(project(undefined, undefined, { separateGitDir: true }));
  const fallback = acceptedItem(unregistered, 'web/fallback.txt', {
    beforeVerify: () => rmSync(join(unregistered.env.PULLBOARD_HOME, 'projects.json'), { force: true }),
  });
  const mergeCommand = `git merge --no-ff ${fallback.commit} -m 'feat(merge): write web/fallback.txt [G1]' ${trailerArg(fallback.id)} && pullboard merged ${fallback.id} HEAD`;
  assert.ok(fallback.out.includes(`next: could not safely locate the primary checkout; run from the main checkout: ${mergeCommand}`), fallback.out);
  assert.doesNotMatch(fallback.out, /\bcd\s/u, 'an unvalidated path is never guessed');
  const ranFallback = spawnSync('/bin/sh', ['-c', mergeCommand], { cwd: unregistered.repo, env: unregistered.env, encoding: 'utf8' });
  assert.equal(ranFallback.status, 0, `${ranFallback.stdout}${ranFallback.stderr}`);
});
