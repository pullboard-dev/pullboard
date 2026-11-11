/**
 * End to end on real repos: the CLI runs as its own process, git runs the installed hooks, and
 * worktrees are real worktrees (B1–B3, B6, V3, V4, V7, L3, L4, C3, I1, I2, P2).
 */
import assert from 'node:assert/strict';
import { runFixtureExecFile as execFileSync } from '../../tests/fixtures/child.js';
import { startFixtureChild as spawn } from '../../tests/fixtures/child.js';
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
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();

after(e2e.cleanup);

const {
  BIN, cockpitSource, sandboxes, sandbox, CONFIG, SPEC, project, holdingGate,
  launch, waitFor, gateEvents, commitFile, attackCommit, privateCheckSubmission,
  startView, LIGHT_BRIEF,
} = e2e;

/**
 * Run `pullboard claim` from two worktrees at once, so both race for the same lock.
 */
function race(box, first, second, id) {
  const one = (cwd) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [BIN, 'claim', String(id)], { cwd, env: box.env });
      let err = '';
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('close', (code) => done({ cwd, code, err }));
    });
  return Promise.all([one(first), one(second)]);
}

test('decisions are asked, listed and answered, and evidence attached, from the command line [B21, B22, B26]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  const asked = box.run(box.web, 'shout', 'coordinator', 'ship', 'today?', '--kind', 'question', '--decision');
  assert.equal(asked.code, 0, asked.err);
  const id = /as #(\d+)/.exec(asked.out)?.[1];
  assert.ok(id, asked.out);
  assert.match(box.run(box.repo, 'decisions').out, new RegExp(`#${id} {2}web-1 \\(fixture-model\\) -> coordinator \\(unknown\\), \\d+m ago: ship today\\?`));
  assert.match(box.run(box.repo, 'inbox').out, new RegExp(`web-1 \\(fixture-model\\) -> coordinator \\(unknown\\): asks for a decision \\(#${id}; pullboard answer ${id}`));
  const wrongActor = box.run(box.repo, 'answer', id, 'yes, today', '--as', 'person');
  assert.notEqual(wrongActor.code, 0);
  assert.match(wrongActor.err, /B26_PERSON_ANSWER.*person mode answers only/);
  assert.match(box.run(box.repo, 'answer', id, 'yes, today').out, new RegExp(`answered #${id} to web-1 \\(fixture-model\\) as #\\d+`));
  assert.match(box.run(box.repo, 'decisions').out, /no open decisions/);
  assert.match(box.run(box.web, 'inbox').out, new RegExp(`coordinator \\(unknown\\) -> web-1 \\(fixture-model\\): answers #${id}: yes, today`));
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const proved = box.run(box.web, 'shout', 'coordinator', 'FINISH', 'the page', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'HEAD');
  assert.equal(proved.code, 0, proved.err);
  assert.match(box.run(box.repo, 'inbox').out, new RegExp(`web-1 \\(fixture-model\\) -> item:1 \\(unknown\\): FINISH the page\\n {2}receipt: measured, #1 at ${head.slice(0, 12)}`));
  assert.match(box.run(box.web, 'shout', 'coordinator', 'x', '--evidence', 'receipt', '--outcome', 'measured', '--item', '1', '--commit', 'nope').err, /BAD_EVIDENCE.*"nope"/);
});

test("a worktree starts only from a commit that holds pullboard's files as the main checkout has them [I4, C4]", () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  assert.equal(box.run(repo, 'init').code, 0);
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(CONFIG, null, 2));
  writeFileSync(join(repo, 'SPEC.md'), SPEC);
  writeFileSync(join(repo, 'notes.txt'), 'mine\n');
  const nothingMade = () => {
    assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
    assert.notEqual(box.tryGit(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/web/1').status, 0, 'no branch');
  };
  /** Refused, with the files it names; returns the command it gives. */
  const refused = (pattern, named) => {
    const said = box.run(repo, 'worktree', 'web');
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

  const first = refused(/\[NOT_COMMITTED\] this repo has no commit yet, and a new worktree starts from one; not committed: /, [
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
  refused(/\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: /, [
    '.githooks/post-checkout (not committed)',
    'DOCTRINE.md (deleted)',
    'SPEC.md (changed)',
  ]);
  box.git(repo, 'checkout', '--', 'DOCTRINE.md');
  sh(refused(/these differ from it here: \.githooks\/post-checkout \(not committed\), SPEC\.md \(changed\)\. /, []));
  assert.equal(box.git(repo, 'diff', '--cached', '--name-only'), 'notes.txt', "the person's staged file stays staged, and out of the commit");

  const made = box.run(repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /repo-web-1 on branch web\/1, joined as web-1 \(fixture-model\) in the web lane/, 'the refusals made nothing and joined no one');
  const web = join(box.dir, 'repo-web-1');
  assert.ok(readFileSync(join(web, 'SPEC.md'), 'utf8').includes('- G3 [draft'), 'it starts with the spec as committed');
  const foreign = commitFile(box, web, 'api/a.js', 'a', 'feat(web): page [G1]');
  assert.match(foreign.stderr, /outside the web lane: api\/a.js/, 'its hooks run');
});

test('a hook git ignores is committed by force before a worktree; a deleted config is restored, never re-initialized [I4, C4]', () => {
  const box = project();
  const sh = (command) => execFileSync('sh', ['-c', command], { env: box.env, encoding: 'utf8', stdio: 'pipe' });
  writeFileSync(join(box.repo, '.gitignore'), '.githooks/post-checkout\n');
  box.git(box.repo, 'add', '.gitignore');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: ignore a local hook');
  writeFileSync(join(box.repo, '.githooks', 'post-checkout'), '#!/bin/sh\n');
  const ignored = box.run(box.repo, 'worktree', 'web');
  assert.equal(ignored.code, 1, ignored.out);
  assert.match(ignored.err, /\[NOT_COMMITTED\] a new worktree starts from the last commit, and these differ from it here: \.githooks\/post-checkout \(not committed; git ignores it\)\. /);
  assert.ok(!existsSync(join(box.dir, 'repo-web-1')), 'no folder');
  const [, command] = ignored.err.match(/Commit them first: (.*)\n/);
  assert.ok(command.includes(' && git add -f -- .githooks/post-checkout && git commit '), command);
  sh(command);
  assert.equal(box.git(box.repo, 'ls-tree', '--name-only', 'HEAD', '--', '.githooks/post-checkout'), '.githooks/post-checkout', 'the ignored hook is committed');
  const made = box.run(box.repo, 'worktree', 'web');
  assert.equal(made.code, 0, made.err);
  assert.ok(existsSync(join(box.dir, 'repo-web-1', '.githooks', 'post-checkout')), 'the worktree has the hook the main checkout runs');

  box.git(box.repo, 'rm', '-q', 'pullboard.json');
  const restore = `cd ${box.repo} && git checkout HEAD -- pullboard.json`;
  for (const args of [['worktree', 'web'], ['status'], ['next']]) {
    const said = box.run(box.repo, ...args);
    assert.equal(said.code, 1, said.out);
    assert.ok(said.err.includes(`[NO_CONFIG] pullboard.json is deleted here, though this checkout's last commit has it: restore it: ${restore}\n`), said.err);
    assert.ok(!said.err.includes('pullboard init'), `${args[0]} never says to run init`);
  }
  assert.ok(!existsSync(join(box.dir, 'repo-web-2')), 'the refused worktree made nothing');
  sh(restore);
  assert.equal(box.run(box.repo, 'status').code, 0, 'restored, the board works again');
  rmSync(join(box.web, 'pullboard.json'));
  assert.ok(box.run(box.web, 'next').err.includes(`restore it: cd ${box.web} && git checkout HEAD -- pullboard.json`), 'a linked worktree restores its own');
});

test('a red gate refuses submit [V4]', () => {
  const box = project();
  writeFileSync(join(box.repo, 'RED'), 'red');
  box.git(box.repo, 'add', 'RED');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: turn the gate red');
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const item = `${box.web}-item-1`;
  assert.equal(commitFile(box, item, 'web/red.html', 'candidate', 'feat(web): red gate witness [G1]').status, 0);
  const refused = box.run(item, 'submit', '1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /GATE_RED/);
});

test('verify runs at the submitted commit, against the criterion frozen at claim [V3, V7, V9, V19]', () => {
  const box = project();
  fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders a heading');
  box.run(box.web, 'claim', '1');
  commitFile(box, box.web, 'web/a.html', '<h1>Hi</h1>', 'feat(web): page [G1]');
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  assert.match(box.run(box.web, 'verify', '1', 'accept').err, /SELF_VERIFY/);
  const unsaid = box.run(box.repo, 'verify', '1', 'accept', '--note', 'ran it');
  assert.match(unsaid.err, /MAIN_IS_COORDINATOR\] this is the main checkout, so this verdict would be the coordinator's/);
  assert.match(unsaid.err, new RegExp(`Agent worktrees: web-1 \\(fixture-model\\) at ${box.web}`));
  assert.match(box.run(box.web, 'verify', '1', 'accept', '--as', 'coordinator').err, /USAGE.*only in the main checkout/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /NOT_AT_COMMIT/);
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  writeFileSync(join(box.repo, 'SPEC.md'), SPEC.replace('The page renders.', 'The page renders a heading.'));
  assert.equal(box.run(box.repo, 'spec', 'approve', 'G1').code, 0);
  box.git(box.repo, 'commit', '-qam', 'docs: tighten G1');
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /CRITERIA_CHANGED/);
  assert.match(box.run(box.repo, 'refreeze', '1').out, /refrozen/);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const refrozenItem = `${box.web}-item-1`;
  assert.equal(commitFile(box, refrozenItem, 'web/a.html', '<h1>Hi again</h1>', 'feat(web): update page [G1]').status, 0);
  const resubmitted = box.run(refrozenItem, 'submit', '1');
  assert.equal(resubmitted.code, 0, resubmitted.err || resubmitted.out);
  const submittedHead = JSON.parse(box.run(box.repo, 'show', '1', '--json').out).item_commit;
  box.git(box.repo, 'switch', '--detach', submittedHead);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator').err, /PROOF_REQUIRED/);
  assert.match(box.run(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'removed the heading; the page test failed').out, /verified #1: CRITERION_MET/);
  const show = box.run(box.repo, 'show', '1').out;
  assert.match(show, /G1: The page renders a heading\./);
  assert.match(show, /ACCEPT CRITERION_MET by coordinator/);
  const ledger = box.run(box.repo, 'ledger').out;
  assert.match(ledger, /1 verified by a second agent/);
  assert.match(ledger, /\| 1 \| web \| Page \| G1 \| web-1 \(fixture-model\) \| coordinator \(unknown\) \|/);
});

test('pre-push runs the gate once per tree and pushes only the checked-out commit [C3]', () => {
  const box = project();
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const first = box.tryGit(box.repo, 'push', '-q', 'origin', 'main');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(box.repo, '.git', 'pullboard-gate-green')));
  assert.match(box.run(box.repo, 'gate').out, /this tree already passed/);
  const elsewhere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one:web/one');
  assert.equal(elsewhere.status, 0, 'web/one is at the same commit as main, so it is what is checked out');
  assert.match(`${elsewhere.stdout}${elsewhere.stderr}`, /the gate passed on this exact tree; not running it twice/, 'the second push of a passed tree skips the gate');
  commitFile(box, box.web, 'web/b.html', 'b', 'feat(web): second page [G1]');
  const notHere = box.tryGit(box.repo, 'push', '-q', 'origin', 'web/one');
  assert.notEqual(notHere.status, 0);
  assert.match(notHere.stderr, /is not checked out/);
});

test('two agents racing for one item: exactly one wins, every time [B2]', async () => {
  const box = project();
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two');
  assert.match(fixtureJoin(box.run, second, 'web', '--route', 'strong').out, /joined as web-2/);
  for (let round = 1; round <= 6; round += 1) {
    fixtureAdd(box.run, box.repo, 'web', `Item ${round}`);
    const results = await race(box, box.web, second, round);
    const winners = results.filter((result) => result.code === 0);
    const losers = results.filter((result) => result.code !== 0);
    assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.match(losers[0].err, /HELD/);
    assert.equal(box.run(winners[0].cwd, 'release', String(round), '--reason', 'BLOCKED').code, 0);
  }
});
