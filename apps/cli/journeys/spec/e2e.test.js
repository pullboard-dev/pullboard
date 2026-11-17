/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from '../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

after(e2e.cleanup);

const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

test('decisions are asked, listed and answered, and evidence attached, from the command line [B21, B22, B26]', async () => {
  const box = project();
  await fixtureAdd(box.runIn, box.repo, 'web', 'Page', '--specs', 'G1');
  const asked = await box.runIn(box.web, 'shout', 'coordinator', 'ship', 'today?', '--kind', 'question', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match((await box.runIn(box.repo, 'decisions')).out, new RegExp(`#${id} {2}web-1 \\(fixture-model\\) -> coordinator \\(unknown\\), \\d+m ago: ship today\\?`));
  assert.match((await box.runIn(box.repo, 'inbox')).out, new RegExp(`web-1 \\(fixture-model\\) -> coordinator \\(unknown\\): asks for a decision \\(#${id}; pullboard answer ${id}`));
  const wrongActor = await box.runIn(box.repo, 'answer', id, 'yes, today', '--as', 'person');
  assert.notEqual(wrongActor.code, 0);
  assert.match(wrongActor.err, /B26_PERSON_ANSWER.*person mode answers only/);
  assert.match((await box.runIn(box.repo, 'answer', id, 'yes, today')).out, new RegExp(`answered #${id} to web-1 \\(fixture-model\\) as #\\d+`));
  assert.match((await box.runIn(box.repo, 'decisions')).out, /no open decisions/);
  assert.match((await box.runIn(box.web, 'inbox')).out, new RegExp(`coordinator \\(unknown\\) -> web-1 \\(fixture-model\\): answers #${id}: yes, today`));
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const proved = await box.runIn(box.web, 'shout', 'coordinator', 'FINISH', 'the page', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'HEAD');
  assert.equal(proved.code, 0, proved.err);
  assert.match((await box.runIn(box.repo, 'inbox')).out, new RegExp(`web-1 \\(fixture-model\\) -> item:1 \\(unknown\\): FINISH the page\\n {2}receipt: measured, #1 at ${head.slice(0, 12)}`));
  assert.match((await box.runIn(box.web, 'shout', 'coordinator', 'x', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'nope')).err, /BAD_EVIDENCE.*"nope"/);
});

test("a worktree starts only from a commit that holds pullboard's files as the main checkout has them [I4, C4]", async () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal((await box.runIn(repo, 'init')).code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'notes.txt'), 'mine\n');
  const nothingMade = () => {
    assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
    assert.notEqual(box.tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/1').status, 0, 'no branch');
  };
  /** Refused, with the files it names; returns the command it gives. */
  const refused = async (pattern, named) => {
    const said = await box.runIn(repo, 'worktree', 'web');
    assert.equal(said.code, 1, said.out);
    assert.match(said.err, pattern);
    for (const file of named) assert.ok(said.err.includes(file), `names ${file}: ${said.err}`);
    assert.ok(!said.err.includes('notes.txt'), 'leaves the person\'s own files out');
    nothingMade();
    const [, command] = said.err.match(/Commit them first: (.*)\n/);
    assert.ok(command.startsWith(`cd ${repo} && git add -- `), command);
    return command;
  };
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });

  const first = await refused(/\[NOT_COMMITTED\] this repo has no commit yet, and a new worktree starts from one; not committed: /, [
    '.githooks/pre-commit',
    'AGENTS.md',
    'DOCTRINE.md',
    'SPEC.md',
    'pullboard.json',
  ]);
  sh(first);
  for (const file of ['.githooks/pre-commit', 'AGENTS.md', 'DOCTRINE.md', 'SPEC.md', 'pullboard.json']) {
    assert.equal(box.git(repo, 'ls-tree', '--name-only', 'HEAD', '--', file), file, `${file} is committed`);
  }
  assert.equal(box.git(repo, 'ls-tree', '--name-only', 'HEAD', '--', 'notes.txt'), '', 'the command commits only those files');

  writeFileSync(join(repo, 'SPEC.md'), `${SPEC}- G3 [draft, aim] A third goal. | gate: test\n`);
  writeFileSync(join(repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  rmSync(join(repo, 'DOCTRINE.md'));
  box.git(repo, 'add', 'notes.txt');
  await refused(/\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: /, [
    '.githooks/post-checkout (not committed)',
    'DOCTRINE.md (deleted)',
    'SPEC.md (changed)',
  ]);
  box.git(repo, 'checkout', '--', 'DOCTRINE.md');
  sh(await refused(/these differ from it here: \.githooks\/post-checkout \(not committed\), SPEC\.md \(changed\)\. /, []));
  assert.equal(box.git(repo, 'diff', '--cached', '--name-only'), 'notes.txt', "the person's staged file stays staged, and out of the commit");

  const made = await box.runIn(repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /repo-web-1 on branch web\/1, joined as web-1 \(fixture-model\) in the web lane/, 'the refusals made nothing and joined no one');
  const web = join(box.dir, 'repo-web-1');
  assert.ok(readFileSync(join(web, 'SPEC.md'), 'utf8').includes('- G3 [draft'), 'it starts with the spec as committed');
  const foreign = await commitFile(box, web, 'api/a.js', 'a', 'feat(web): page [G1]');
  assert.match(foreign.stderr, /outside the web lane: api\/a.js/, 'its hooks run');
});

test('a hook git ignores is committed by force before a worktree; a deleted config is restored, never re-initialized [I4, C4]', async () => {
  const box = project();
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(join(box.repo, '.gitignore'), '.githooks/post-checkout\n');
  box.git(box.repo, 'add', '.gitignore');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: ignore a local hook');
  writeFileSync(join(box.repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  const ignored = await box.runIn(box.repo, 'worktree', 'web');
  assert.equal(ignored.code, 1, ignored.out);
  assert.match(ignored.err, /\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: \.githooks\/post-checkout \(not committed; git ignores it\)\. /);
  assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
  const [, command] = ignored.err.match(/Commit them first: (.*)\n/);
  assert.ok(command.includes(' && git add -f -- .githooks/post-checkout && git commit '), command);
  sh(command);
  assert.equal(box.git(box.repo, 'ls-tree', '--name-only', 'HEAD', '--', '.githooks/post-checkout'), '.githooks/post-checkout', 'the ignored hook is committed');
  const made = await box.runIn(box.repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.ok(existsSync(join(box.dir, 'repo-web-1', '.githooks', 'post-checkout')), 'the worktree has the hook the main checkout runs');

  box.git(box.repo, 'rm', '-q', 'pullboard.json');
  const restore = `cd ${box.repo} && git checkout HEAD -- pullboard.json`;
  for (const args of [['worktree', 'web'], ['status'], ['next']]) {
    const said = await box.runIn(box.repo, ...args);
    assert.equal(said.code, 1, said.out);
    assert.ok(said.err.includes(`[NO_CONFIG] pullboard.json is deleted here, though this checkout's last commit has it: restore it: ${restore}\n`), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${args[0]} never says to run init`);
  }
  assert.ok(!existsSync(join(box.dir, 'repo-web-2')), 'the refused worktree made nothing');
  sh(restore);
  assert.equal((await box.runIn(box.repo, 'status')).code, 0, 'restored, the board works again');
  rmSync(join(box.web, 'pullboard.json'));
  assert.ok((await box.runIn(box.web, 'next')).err.includes(`restore it: cd ${box.web} && git checkout HEAD -- pullboard.json`), 'a linked worktree restores its own');
});

test('clause 1: a journey commit through box.tryGit is awaited and answers its status with test.inProcessHooks on [C7]', async () => {
  const box = project();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { test: { inProcessHooks: true } });
  const committed = await commitFile(box, box.repo, 'docs/awaited.md', 'awaited\n', 'docs: awaited commit');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
  assert.equal(box.git(box.repo, 'log', '-1', '--format=%s'), 'docs: awaited commit', 'the commit landed before the journey went on');
});
