/** Exact clean source composition and named conflict without fabricated edits [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { mergeSubmissionMain } from '../../../../packages/merge/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Real worktree with independent builder and main changes. */
function project(t, conflict = false) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-auto-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), work = join(root, 'work');
  mkdirSync(main);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Builder', GIT_AUTHOR_EMAIL: 'builder@example.invalid',
    GIT_COMMITTER_NAME: 'Builder', GIT_COMMITTER_EMAIL: 'builder@example.invalid' };
  const git = (dir, ...args) => runFixtureGit(args, { cwd: dir, env }).trim();
  writeFileSync(join(main, 'shared.txt'), 'base\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'config', 'user.name', 'Builder'); git(main, 'config', 'user.email', 'builder@example.invalid'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'build', work, 'main');
  writeFileSync(join(work, conflict ? 'shared.txt' : 'builder.txt'), 'builder\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'builder');
  const source = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(main, conflict ? 'shared.txt' : 'trunk.txt'), 'main\n');
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'main');
  return { main, work, git, source, trunk: git(main, 'rev-parse', 'HEAD') };
}

test('a clean main move creates exactly the builder-attributed merge tree [C7,V4]', t => {
  const p = project(t), expected = p.git(p.work, 'merge-tree', '--write-tree', p.source, p.trunk).split('\n')[0];
  const result = mergeSubmissionMain(p.work, p.trunk);
  assert.equal(result.source, p.source); assert.equal(result.merged, true);
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD^{tree}'), expected);
  assert.deepEqual(p.git(p.work, 'show', '-s', '--format=%P', result.commit).split(' '), [p.source, p.trunk]);
  assert.equal(p.git(p.work, 'show', '-s', '--format=%an <%ae>', result.commit), 'Builder <builder@example.invalid>');
  assert.equal(p.git(p.work, 'status', '--porcelain'), '');
  assert.equal(mergeSubmissionMain(p.work, p.trunk).merged, false);
});

test('a conflicting main move names the file and leaves the source untouched [C7,V4]', t => {
  const p = project(t, true);
  assert.throws(() => mergeSubmissionMain(p.work, p.trunk), error => error.code === 'MERGE_CONFLICT' && error.message.includes('shared.txt'));
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), p.source);
  assert.equal(p.git(p.work, 'status', '--porcelain'), '');
});

test('submit composes moved main before its actual frozen check [C7,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'auto merge', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', "test -f web/feature.txt && test -f web/main.txt", '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  const committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', 'feat(web): add auto merge fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/main.txt'), 'main\n');
  box.git(box.repo, 'add', 'web/main.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance main');
  const trunk = box.git(box.repo, 'rev-parse', 'HEAD');
  const result = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  assert.deepEqual(box.git(box.web, 'show', '-s', '--format=%P', head).split(' '), [source, trunk]);
  assert.equal(box.git(box.web, 'show', '-s', '--format=%ae', head), box.git(box.web, 'show', '-s', '--format=%ae', source));
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.equal(JSON.parse(shown.out).item_commit, head);
  assert.match(JSON.stringify(JSON.parse(shown.out)), /Builder web-1 automatic main merge/u);
});

test('a reviewer checks a builder-attributed composition when main moved [C7,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.verify = { policy: 'any', family: 'off', composeAtAdmission: true };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: compose at admission');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'review auto merge', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', 'test -f web/feature.txt', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  const committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', 'feat(web): add review fixture [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(submitted.code, 0, `${submitted.err}\n${submitted.out}`);
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  const review = join(box.dir, 'review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, source);
  const joined = fixtureJoin(box.run, review, 'api', '--route', 'strong');
  assert.equal(joined.code, 0, joined.err);
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  writeFileSync(join(box.repo, 'docs/review-main.txt'), 'review main\n');
  box.git(box.repo, 'add', 'docs/review-main.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance review main');
  const trunk = box.git(box.repo, 'rev-parse', 'HEAD');
  const result = box.run(review, 'verify', String(id), 'accept', '--note', 'checked the merged source', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const refs = box.git(box.repo, 'for-each-ref', '--format=%(objectname)', `refs/pullboard/items/${id}/`).split('\n').filter(Boolean);
  assert.ok(refs.length, 'the actual reviewed composition is retained');
  const merged = refs.find(ref => box.git(box.repo, 'show', '-s', '--format=%P', ref).split(' ').includes(trunk));
  assert.ok(merged, `review ref includes main ${trunk}`);
  const shown = box.run(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.match(JSON.stringify(JSON.parse(shown.out)), new RegExp(`Automatic main merge ${merged}.*builder web-1`, 'u'));
  assert.equal(box.git(review, 'rev-parse', 'HEAD'), source, 'private review composition leaves the checkout unchanged');
});

test('submit names a real main conflict and leaves the builder checkout intact [C7,V4]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const base = helpers.commitFile(box, box.repo, 'web/shared.txt', 'base\n', 'feat(web): seed conflict fixture [G1]');
  assert.equal(base.status, 0, base.stderr);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'conflicting auto merge', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', 'test -f web/shared.txt', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  const sourceChange = helpers.commitFile(box, box.web, 'web/shared.txt', 'builder\n', 'feat(web): edit shared file [G1]');
  assert.equal(sourceChange.status, 0, sourceChange.stderr);
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  const trunkChange = helpers.commitFile(box, box.repo, 'web/shared.txt', 'main\n', 'feat(web): independently edit file [G1]');
  assert.equal(trunkChange.status, 0, trunkChange.stderr);
  const result = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out);
  const refusal = JSON.parse(result.out).error;
  assert.equal(refusal.code, 'MERGE_CONFLICT');
  assert.match(refusal.message, /web\/shared\.txt/u);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), source);
  assert.equal(box.git(box.web, 'status', '--porcelain'), '');
});
