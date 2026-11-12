/** @pullboard-test-input packages/gate/src/io/check/signoffs.js */
/** A fresh board's real installed hook accepts only its live claimed item as a temporary citation [I1,N26]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a push whose base has no maintainers list passes with the policy not active [C1,C7]', async () => {
  const box = e2e.sandbox();
  const repo = join(box.dir, 'signoff-bootstrap');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const configPath = join(repo, 'pullboard.json');
  writeFileSync(configPath, JSON.stringify({ project: 'bootstrap' }));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: base before sign-off activation');
  const inactiveBase = box.git(repo, 'rev-parse', 'HEAD').trim();
  box.env.GIT_AUTHOR_NAME = 'Outside Person';
  box.env.GIT_AUTHOR_EMAIL = 'outside@example.com';
  writeFileSync(configPath, JSON.stringify({ maintainers: ['outside@example.com'] }));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: unsigned activation-era contribution');
  const event = join(box.dir, 'push.json');
  /** Run the public CI entry point against a real push event and exact Git objects. */
  const checkPush = before => {
    writeFileSync(event, JSON.stringify({ before, after: box.git(repo, 'rev-parse', 'HEAD').trim() }));
    return runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../../packages/gate/src/io/check/signoffs.js')], {
      cwd: repo, encoding: 'utf8',
      env: { ...box.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event },
    });
  };
  const bootstrap = checkPush(inactiveBase);
  assert.equal(bootstrap.status, 0, bootstrap.failure || bootstrap.stderr);
  assert.equal(bootstrap.stdout, 'sign-off policy not active at base ' + inactiveBase + '\n');

  // An inactive base never reads policy from the contribution, even when that JSON is invalid.
  writeFileSync(configPath, '{broken head policy');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: unreadable contribution policy');
  const opaqueHead = checkPush(inactiveBase);
  assert.equal(opaqueHead.status, 0, opaqueHead.failure || opaqueHead.stderr);
  assert.equal(opaqueHead.stdout, bootstrap.stdout);
  const initialPush = checkPush('0'.repeat(40));
  assert.equal(initialPush.status, 0, initialPush.failure || initialPush.stderr);
  assert.equal(initialPush.stdout, 'sign-off policy not active at base (none)\n');

  box.env.GIT_AUTHOR_NAME = 'Test Agent';
  box.env.GIT_AUTHOR_EMAIL = 'agent@example.com';
  writeFileSync(configPath, JSON.stringify({ maintainers: ['agent@example.com'] }));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: trusted activation policy');
  const activeBase = box.git(repo, 'rev-parse', 'HEAD').trim();
  box.env.GIT_AUTHOR_NAME = 'Outside Person';
  box.env.GIT_AUTHOR_EMAIL = 'outside@example.com';
  writeFileSync(configPath, JSON.stringify({ maintainers: ['outside@example.com'] }));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: try to exempt an unsigned outside head');
  const unsignedHead = box.git(repo, 'rev-parse', 'HEAD').trim();
  const refused = checkPush(activeBase);
  assert.equal(refused.status, 1, refused.failure || refused.stderr);
  assert.match(refused.stderr, /git commit --amend -s/u);
  assert.ok(refused.stderr.includes(unsignedHead.slice(0, 12)), 'the trusted base defeats head self-enrollment');
  assert.doesNotMatch(refused.stdout, /policy not active/u);
});

test('an outside commit without a sign-off is refused with its fix [C1,C7]', async () => {
  const box = e2e.sandbox();
  const repo = join(box.dir, 'signoff-hook');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  await moved(box, repo, 'init');
  const configPath = join(repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.maintainers = ['agent@example.com'];
  writeFileSync(configPath, JSON.stringify(config));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: configure sign-off fixture');
  writeFileSync(join(repo, 'README.md'), 'A real member commit.\n');
  box.git(repo, 'add', 'README.md');
  const member = box.tryGit(repo, 'commit', '-q', '-m', 'chore: record member work');
  assert.equal(member.status, 0, member.failure || member.stderr);

  box.env.GIT_AUTHOR_NAME = 'Outside Person';
  box.env.GIT_AUTHOR_EMAIL = 'outside@example.com';
  writeFileSync(join(repo, 'README.md'), 'An outside contribution.\n');
  box.git(repo, 'add', 'README.md');
  const missing = box.tryGit(repo, 'commit', '-q', '-m', 'chore: contribute outside work');
  assert.notEqual(missing.status, 0, 'the installed commit-msg hook must refuse an unsigned outside author');
  assert.match(missing.stderr, /git commit --amend -s/u);
  assert.equal(missing.stderr.trim().split('\n').length, 1, 'the refusal is one actionable line');
  const wrong = box.tryGit(repo, 'commit', '-q', '-s', '-m', 'chore: contribute outside work');
  assert.notEqual(wrong.status, 0, 'the member committer sign-off cannot stand in for the outside author');
  const signed = box.tryGit(repo, 'commit', '-q', '-m', 'chore: contribute outside work',
    '-m', 'Signed-off-by: Outside Person <outside@example.com>');
  assert.equal(signed.status, 0, signed.failure || signed.stderr);

  // A contributor without Pullboard hooks can send a multi-commit PR; CI checks its whole range.
  const incoming = join(box.dir, 'outside-pr');
  mkdirSync(incoming);
  box.git(incoming, 'init', '-q', '-b', 'main');
  box.env.GIT_AUTHOR_NAME = 'Test Agent';
  box.env.GIT_AUTHOR_EMAIL = 'agent@example.com';
  writeFileSync(join(incoming, 'pullboard.json'), JSON.stringify({ maintainers: ['agent@example.com'] }));
  box.git(incoming, 'add', '-A');
  box.git(incoming, 'commit', '-q', '-m', 'chore: trusted base');
  const base = box.git(incoming, 'rev-parse', 'HEAD').trim();
  box.env.GIT_AUTHOR_NAME = 'Outside Person';
  box.env.GIT_AUTHOR_EMAIL = 'outside@example.com';
  writeFileSync(join(incoming, 'pullboard.json'), JSON.stringify({ maintainers: ['outside@example.com'] }));
  box.git(incoming, 'add', '-A');
  box.git(incoming, 'commit', '-q', '-m', 'chore: unsigned earlier contribution');
  const unsigned = box.git(incoming, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(incoming, 'README.md'), 'Signed later work.\n');
  box.git(incoming, 'add', '-A');
  box.git(incoming, 'commit', '-q', '-m', 'chore: signed head',
    '-m', 'Signed-off-by: Outside Person <outside@example.com>');
  const event = join(box.dir, 'pull-request.json');
  const check = () => {
    writeFileSync(event, JSON.stringify({ pull_request: {
      base: { sha: base }, head: { sha: box.git(incoming, 'rev-parse', 'HEAD').trim() },
    } }));
    return runFixtureChild(process.execPath, [resolve(import.meta.dirname, '../../../../packages/gate/src/io/check/signoffs.js')], {
      cwd: incoming, encoding: 'utf8',
      env: { ...box.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event },
    });
  };
  const refused = check();
  assert.equal(refused.status, 1, refused.failure || refused.stderr);
  assert.ok(refused.stderr.includes(unsigned.slice(0, 12)), 'CI names the earlier unsigned commit, not just HEAD');
  assert.match(refused.stderr, /git commit --amend -s/u);
  assert.equal(refused.stderr.trim().split('\n').length, 1);
  box.git(incoming, 'reset', '--soft', base);
  box.git(incoming, 'commit', '-q', '-m', 'chore: sign the whole contribution',
    '-m', 'Signed-off-by: Outside Person <outside@example.com>');
  const accepted = check();
  assert.equal(accepted.status, 0, accepted.failure || accepted.stderr);

  const signedHead = box.git(incoming, 'rev-parse', 'HEAD').trim();
  box.git(incoming, 'checkout', '-q', '--detach', base);
  writeFileSync(join(incoming, 'other.txt'), 'A separately signed parent.\n');
  box.git(incoming, 'add', 'other.txt');
  box.git(incoming, 'commit', '-q', '-m', 'chore: signed other parent',
    '-m', 'Signed-off-by: Outside Person <outside@example.com>');
  const otherParent = box.git(incoming, 'rev-parse', 'HEAD').trim();
  box.git(incoming, 'checkout', '-q', '--detach', signedHead);
  box.env.GIT_AUTHOR_NAME = 'Merge Bot';
  box.env.GIT_AUTHOR_EMAIL = 'merge-bot@example.com';
  box.git(incoming, 'merge', '--no-ff', '--no-edit', otherParent);
  assert.equal(check().status, 0, 'a merge wrapper is checked through both non-merge parents');
  writeFileSync(join(incoming, 'bot.txt'), 'A bot contribution.\n');
  box.git(incoming, 'add', 'bot.txt');
  box.git(incoming, 'commit', '-q', '-m', 'chore: unsigned bot work');
  assert.equal(check().status, 1, 'a non-member bot commit still needs its own author sign-off');
});

/** Require a real CLI move to succeed before a dependent fixture step. */
async function moved(box, root, ...args) {
  const result = await box.runLocal(root, ...args);
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

test('a fresh board accepts a first commit that cites its item [I1,N26]', async () => {
  const box = e2e.sandbox();
  const repo = join(box.dir, 'fresh');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  await moved(box, repo, 'init');
  await moved(box, repo, 'lane', 'add', 'app', '--owns', 'app/');
  mkdirSync(join(repo, 'app'));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the fresh board');
  const rows = JSON.parse((await moved(box, repo, 'spec', '--json')).out).rows;
  assert.equal(rows.filter(row => row.file === 'SPEC.md' && row.status === 'approved').length, 0, 'the real fresh board has no approved row');
  for (const title of ['Own first feature', 'Another builder feature', 'Unclaimed feature']) {
    await moved(box, repo, 'add', 'app', title, '--criterion', title + ' works.');
  }
  const own = join(box.dir, 'own');
  const other = join(box.dir, 'other');
  for (const root of [own, other]) {
    box.git(repo, 'worktree', 'add', '-q', '--detach', root, 'main');
    const joined = joinFixtureSeat(box, root, 'app');
    assert.equal(joined.code, 0, joined.err || joined.out);
  }
  await moved(box, own, 'claim', '1');
  await moved(box, other, 'claim', '2');
  mkdirSync(join(own, 'app'));
  writeFileSync(join(own, 'app/first.txt'), 'first useful feature\n');
  box.git(own, 'add', 'app/first.txt');
  for (const citation of ['#999', '#3', '#2']) {
    const refused = box.tryGit(own, 'commit', '-q', '-m', `feat(app): build the first feature ${citation}`);
    assert.notEqual(refused.status, 0, citation + ' cannot replace an owned live claim');
    assert.match(refused.stderr, /pullboard commit-msg/iu, 'the actual installed message hook refuses the citation');
  }
  await moved(box, own, 'release', '1', '--reason', 'BLOCKED');
  const released = box.tryGit(own, 'commit', '-q', '-m', 'feat(app): build the first feature #1');
  assert.notEqual(released.status, 0, 'a released claim cannot authorize a citation');
  await moved(box, own, 'claim', '1');
  const first = box.tryGit(own, 'commit', '-q', '-m', 'feat(app): build the first feature #1');
  assert.equal(first.status, 0, first.failure || first.stderr || first.stdout);

  const drafted = JSON.parse((await moved(box, repo, 'spec', 'draft', 'The first useful feature works.', '--json')).out).id;
  await moved(box, repo, 'spec', 'approve', drafted);
  await moved(box, repo, 'spec', 'apply');
  box.git(repo, 'add', 'SPEC.md');
  box.git(repo, 'commit', '-q', '-m', 'docs: record the approved requirement');
  box.git(own, 'merge', '--no-edit', 'main');
  writeFileSync(join(own, 'app/first.txt'), 'first useful feature with an approved requirement\n');
  box.git(own, 'add', 'app/first.txt');
  for (const header of ['feat(app): extend the first feature', 'feat(app): extend the first feature #1']) {
    const refused = box.tryGit(own, 'commit', '-q', '-m', header);
    assert.notEqual(refused.status, 0, 'approved boards retain their spec-citation requirement');
    assert.ok(refused.stderr.includes(drafted), 'the refusal names a real usable approved row');
  }
  const approved = box.tryGit(own, 'commit', '-q', '-m', `feat(app): extend the first feature [${drafted}]`);
  assert.equal(approved.status, 0, approved.failure || approved.stderr || approved.stdout);
});
